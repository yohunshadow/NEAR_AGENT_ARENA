//! Sandbox coverage for one full round, a matchup tie, an empty round,
//! retire/revive, double-claim, and the offline worker talking to this chain.

use anyhow::{anyhow, bail, Context, Result};
use near_workspaces::network::Sandbox;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::process::Command;

fn wasm_bytes() -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../target/wasm32-unknown-unknown/release/near_agent_arena.wasm");
    std::fs::read(&path).unwrap_or_else(|err| {
        panic!("build the contract first with scripts/build-wasm.sh ({path:?}): {err}");
    })
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0xf) as usize] as char);
    }
    out
}

fn commitment(move_id: u8, salt: &[u8; 32], reasoning: &str) -> String {
    let mut preimage = vec![move_id];
    preimage.extend_from_slice(salt);
    preimage.extend_from_slice(reasoning.as_bytes());
    encode_hex(Sha256::digest(&preimage).as_slice())
}

struct World {
    worker: Worker<Sandbox>,
    contract: Contract,
    agents: Vec<Account>,
    alice: Account,
    bob: Account,
    patron: Account,
    block_ns: u64,
}

async fn call(result: near_workspaces::result::ExecutionFinalResult) -> Result<()> {
    if result.is_success() {
        return Ok(());
    }
    let err = result.into_result().unwrap_err();
    bail!("{err:?}");
}

async fn view(contract: &Contract, method: &str, args: Value) -> Result<Value> {
    let result = contract
        .view(method)
        .args_json(args)
        .await
        .with_context(|| format!("view {method}"))?;
    Ok(result.json()?)
}

async fn arena(contract: &Contract) -> Result<Value> {
    view(contract, "get_arena", json!({})).await
}

async fn boot(deposit_near: u128, upkeep_near: &str, min_near: &str) -> Result<World> {
    let worker = near_workspaces::sandbox().await?;
    let before = worker.view_block().await?;
    worker.fast_forward(1).await?;
    let after = worker.view_block().await?;
    let block_ns = after.timestamp().saturating_sub(before.timestamp()).max(1);
    eprintln!("sandbox block step {block_ns} ns");

    let contract = worker.dev_deploy(&wasm_bytes()).await?;
    let mut agents = Vec::new();
    for _ in 0..3 {
        agents.push(worker.dev_create_account().await?);
    }
    let alice = worker.dev_create_account().await?;
    let bob = worker.dev_create_account().await?;
    let patron = worker.dev_create_account().await?;
    // Headroom for the transactions in a phase, measured in real sandbox blocks.
    let window = (block_ns.saturating_mul(40)).max(5_000_000_000);
    let outcome = contract
        .call("new")
        .args_json(json!({
            "owner_id": contract.id(),
            "agents": [
                {"account_id": agents[0].id(), "name": "Momentum"},
                {"account_id": agents[1].id(), "name": "Mean-Reversion"},
                {"account_id": agents[2].id(), "name": "Breakout"},
            ],
            "betting_duration_ns": window.to_string(),
            "reveal_duration_ns": window.to_string(),
            "upkeep": upkeep_near,
            "winner_fee_bps": 500,
            "min_treasury": min_near,
        }))
        .deposit(NearToken::from_yoctonear(deposit_near))
        .transact()
        .await?;
    call(outcome).await?;
    Ok(World {
        worker,
        contract,
        agents,
        alice,
        bob,
        patron,
        block_ns,
    })
}

async fn wait_until(world: &World, want: &str) -> Result<Value> {
    for _ in 0..120 {
        let snapshot = arena(&world.contract).await?;
        let phase = snapshot["current"]["phase"].as_str().unwrap_or("");
        let ready = snapshot["current"]["ready_to_settle"]
            .as_bool()
            .unwrap_or(false);
        let matched = match want {
            "reveal" => phase == "reveal" && !ready,
            "ready" => ready,
            other => phase == other,
        };
        if matched {
            return Ok(snapshot);
        }
        world.worker.fast_forward(1).await?;
    }
    bail!("timed out waiting for {want} (block {} ns)", world.block_ns);
}

fn yocto(near: u128) -> u128 {
    near * 10u128.pow(24)
}

async fn settle_round(world: &World) -> Result<()> {
    let begin = world
        .alice
        .call(world.contract.id(), "begin_settle")
        .transact()
        .await?;
    call(begin).await?;
    let snapshot = arena(&world.contract).await?;
    let current = &snapshot["current"];
    let begun = json_u64(&current["settle_height"])
        .with_context(|| format!("settle_height in {current}"))?;
    let height = json_u64(&current["block_height"])
        .with_context(|| format!("block_height in {current}"))?;
    if height <= begun {
        world.worker.fast_forward(1).await?;
    }
    let mut fin = world
        .alice
        .call(world.contract.id(), "finalize_settle")
        .transact()
        .await?;
    if fin.is_failure() {
        world.worker.fast_forward(1).await?;
        fin = world
            .alice
            .call(world.contract.id(), "finalize_settle")
            .transact()
            .await?;
    }
    call(fin).await
}

async fn commit(
    world: &World,
    agent: usize,
    move_id: u8,
    salt: &[u8; 32],
    reasoning: &str,
) -> Result<()> {
    let round_id = arena(&world.contract).await?["current"]["id"]
        .as_u64()
        .unwrap();
    let outcome = world.agents[agent]
        .call(world.contract.id(), "commit")
        .args_json(json!({
            "round_id": round_id.to_string(),
            "commitment_hex": commitment(move_id, salt, reasoning),
        }))
        .transact()
        .await?;
    call(outcome).await
}

async fn reveal(
    world: &World,
    agent: usize,
    move_id: u8,
    salt: &[u8; 32],
    reasoning: &str,
) -> Result<()> {
    let round_id = arena(&world.contract).await?["current"]["id"]
        .as_u64()
        .unwrap();
    let outcome = world.agents[agent]
        .call(world.contract.id(), "reveal")
        .args_json(json!({
            "round_id": round_id.to_string(),
            "move_id": move_id,
            "salt_hex": encode_hex(salt),
            "reasoning": reasoning,
        }))
        .transact()
        .await?;
    call(outcome).await
}

#[tokio::test]
async fn full_round_pays_the_winner_and_rejects_a_second_claim() -> Result<()> {
    let world = boot(yocto(7), &yocto(1).to_string(), &yocto(1).to_string()).await?;
    let salts = [[1u8; 32], [2u8; 32], [3u8; 32]];
    // Balanced beats both Aggressive plays, whatever the seed is.
    commit(&world, 0, 0, &salts[0], "trend").await?;
    commit(&world, 1, 0, &salts[1], "fade").await?;
    commit(&world, 2, 1, &salts[2], "break").await?;
    let back = world
        .alice
        .call(world.contract.id(), "back_agent")
        .args_json(json!({"agent_id": 2}))
        .deposit(NearToken::from_near(2))
        .transact()
        .await?;
    call(back).await?;
    let back = world
        .bob
        .call(world.contract.id(), "back_agent")
        .args_json(json!({"agent_id": 0}))
        .deposit(NearToken::from_near(2))
        .transact()
        .await?;
    call(back).await?;

    let outsider = world
        .patron
        .call(world.contract.id(), "commit")
        .args_json(json!({"round_id": "0", "commitment_hex": "11".repeat(32)}))
        .transact()
        .await?;
    assert!(outsider.is_failure(), "a non-agent must not commit");

    wait_until(&world, "reveal").await?;
    reveal(&world, 0, 0, &salts[0], "trend").await?;
    reveal(&world, 1, 0, &salts[1], "fade").await?;
    reveal(&world, 2, 1, &salts[2], "break").await?;
    settle_round(&world).await?;

    let snapshot = arena(&world.contract).await?;
    assert_eq!(snapshot["current"]["id"], 1);
    let settled = &snapshot["recent_rounds"][0];
    assert_eq!(settled["winner"], 2);
    assert_eq!(settled["reasonings"][2], "break");
    assert!(settled["fee"].as_str().unwrap() != "0");

    let preview: String = view(
        &world.contract,
        "preview_commitment",
        json!({"move_id": 0, "salt_hex": "11".repeat(32), "reasoning": "hold"}),
    )
    .await?
    .as_str()
    .unwrap()
    .to_string();
    assert_eq!(
        preview,
        "16594f519d35ce091c78f92496d035a657d018a79b21e03f5a053a71a33a82d7"
    );

    let claim = world
        .alice
        .call(world.contract.id(), "claim")
        .args_json(json!({"round_id": "0"}))
        .transact()
        .await?;
    call(claim).await?;
    let again = world
        .alice
        .call(world.contract.id(), "claim")
        .args_json(json!({"round_id": "0"}))
        .transact()
        .await?;
    assert!(again.is_failure(), "double claim must fail");
    let bob = world
        .bob
        .call(world.contract.id(), "claim")
        .args_json(json!({"round_id": "0"}))
        .transact()
        .await?;
    assert!(bob.is_failure(), "a losing backer has nothing to claim");
    let bet = view(
        &world.contract,
        "get_user_bet",
        json!({"account_id": world.alice.id(), "round_id": "0"}),
    )
    .await?;
    assert_eq!(bet["claimed"], true);
    Ok(())
}

#[tokio::test]
async fn identical_moves_follow_the_tie_rule() -> Result<()> {
    let world = boot(yocto(7), "0", "1").await?;
    let salts = [[4u8; 32], [5u8; 32], [6u8; 32]];
    for agent in 0..3 {
        commit(&world, agent, 1, &salts[agent], "same").await?;
    }
    wait_until(&world, "reveal").await?;
    for agent in 0..3 {
        reveal(&world, agent, 1, &salts[agent], "same").await?;
    }
    settle_round(&world).await?;
    let settled = &arena(&world.contract).await?["recent_rounds"][0];
    let scores: Vec<u64> = settled["scores"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_u64().unwrap())
        .collect();
    let seed = hex_to_bytes(settled["seed_hex"].as_str().unwrap())?;
    let mut best = scores[0];
    let mut winner = 0u64;
    for (index, score) in scores.iter().enumerate().skip(1) {
        if *score > best {
            best = *score;
            winner = index as u64;
        }
    }
    assert_eq!(
        settled["winner"], winner,
        "seed bytes {seed:?} scores {scores:?}"
    );
    assert_eq!(settled["matchups"], json!([2, 2, 2]));
    if scores.iter().all(|score| *score == scores[0]) {
        assert_eq!(winner, 0, "a total tie goes to the lowest id");
    }
    Ok(())
}

#[tokio::test]
async fn empty_round_charges_upkeep_and_opens_the_next() -> Result<()> {
    let world = boot(yocto(7), &yocto(1).to_string(), &yocto(1).to_string()).await?;
    let before = arena(&world.contract).await?;
    let treasury: u128 = before["agents"][0]["treasury"].as_str().unwrap().parse()?;
    wait_until(&world, "ready").await?;
    settle_round(&world).await?;
    let after = arena(&world.contract).await?;
    assert_eq!(after["current"]["id"], 1);
    assert_eq!(after["recent_rounds"][0]["pool"], "0");
    assert!(after["recent_rounds"][0]["winner"].is_null());
    let next: u128 = after["agents"][0]["treasury"].as_str().unwrap().parse()?;
    assert_eq!(treasury - next, yocto(1));
    assert!(!after["agents"][0]["retired"].as_bool().unwrap());
    Ok(())
}

#[tokio::test]
async fn retire_and_revive() -> Result<()> {
    let world = boot(0, &yocto(1).to_string(), &yocto(1).to_string()).await?;
    let initial = arena(&world.contract).await?;
    assert!(initial["agents"]
        .as_array()
        .unwrap()
        .iter()
        .all(|agent| agent["retired"] == true));
    let denied = world
        .alice
        .call(world.contract.id(), "back_agent")
        .args_json(json!({"agent_id": 0}))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?;
    assert!(denied.is_failure());

    let fund = world
        .patron
        .call(world.contract.id(), "fund_agent")
        .args_json(json!({"agent_id": 0}))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?;
    call(fund).await?;
    let alive = arena(&world.contract).await?;
    assert_eq!(alive["agents"][0]["retired"], false);
    assert_eq!(alive["current"]["alive"][0], true);
    let back = world
        .alice
        .call(world.contract.id(), "back_agent")
        .args_json(json!({"agent_id": 0}))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?;
    call(back).await?;

    wait_until(&world, "ready").await?;
    settle_round(&world).await?;
    let retired = arena(&world.contract).await?;
    assert_eq!(retired["agents"][0]["retired"], true);
    assert_eq!(retired["agents"][0]["treasury"], "0");
    assert_eq!(retired["recent_rounds"][0]["refund"], true);

    let claim = world
        .alice
        .call(world.contract.id(), "claim")
        .args_json(json!({"round_id": "0"}))
        .transact()
        .await?;
    call(claim).await?;
    let again = world
        .alice
        .call(world.contract.id(), "claim")
        .args_json(json!({"round_id": "0"}))
        .transact()
        .await?;
    assert!(again.is_failure(), "refund cannot be claimed twice");

    let revive = world
        .patron
        .call(world.contract.id(), "fund_agent")
        .args_json(json!({"agent_id": 1}))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?;
    call(revive).await?;
    let revived = arena(&world.contract).await?;
    assert_eq!(revived["agents"][1]["retired"], false);
    assert_eq!(revived["current"]["alive"][1], true);
    Ok(())
}

#[tokio::test]
async fn withdraw_treasury_pays_the_agent_account() -> Result<()> {
    let world = boot(yocto(7), "0", "1").await?;
    let before: u128 = arena(&world.contract).await?["agents"][0]["treasury"]
        .as_str()
        .unwrap()
        .parse()?;
    let pulled = yocto(1);
    let withdraw = world.agents[0]
        .call(world.contract.id(), "withdraw_treasury")
        .args_json(json!({"agent_id": 0, "amount": pulled.to_string()}))
        .transact()
        .await?;
    call(withdraw).await?;
    let mid: u128 = arena(&world.contract).await?["agents"][0]["treasury"]
        .as_str()
        .unwrap()
        .parse()?;
    assert_eq!(before - mid, pulled);
    let stranger = world
        .bob
        .call(world.contract.id(), "withdraw_treasury")
        .args_json(json!({"agent_id": 0, "amount": "1"}))
        .transact()
        .await?;
    assert!(
        stranger.is_failure(),
        "a stranger cannot withdraw a treasury"
    );
    let rest = mid;
    // Owner is the contract account. The NEAR is sent to the agent, not the owner.
    let owner_pull = world
        .contract
        .call("withdraw_treasury")
        .args_json(json!({"agent_id": 0, "amount": rest.to_string()}))
        .transact()
        .await?;
    call(owner_pull).await?;
    let after = arena(&world.contract).await?;
    assert_eq!(after["agents"][0]["treasury"], "0");
    assert_eq!(after["agents"][0]["retired"], true);
    assert_eq!(after["current"]["alive"][0], false);
    Ok(())
}

#[tokio::test]
async fn worker_offline_mode_commits_and_settles() -> Result<()> {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../agent/dist/index.js");
    if !script.exists() {
        bail!("build the worker first: cd agent && npm install && npm run build ({script:?})");
    }
    let world = boot(yocto(7), &yocto(1).to_string(), &yocto(1).to_string()).await?;
    let state_dir = std::env::temp_dir().join(format!("arena-worker-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&state_dir);
    std::fs::create_dir_all(&state_dir)?;
    let run = |extra: &[(&str, String)]| -> Result<std::process::Output> {
        let mut command = Command::new("node");
        command
            .arg(&script)
            .current_dir(script.parent().unwrap().parent().unwrap())
            .env("CONTRACT_ID", world.contract.id().as_str())
            .env("NEAR_RPC_URL", world.worker.rpc_addr())
            .env("NEAR_NETWORK_ID", "sandbox")
            .env("NEAR_AI_API_KEY", "")
            .env("STATE_DIR", &state_dir)
            .env("AGENT_0_ACCOUNT_ID", world.agents[0].id().as_str())
            .env(
                "AGENT_0_PRIVATE_KEY",
                world.agents[0].secret_key().to_string(),
            )
            .env("AGENT_1_ACCOUNT_ID", world.agents[1].id().as_str())
            .env(
                "AGENT_1_PRIVATE_KEY",
                world.agents[1].secret_key().to_string(),
            )
            .env("AGENT_2_ACCOUNT_ID", world.agents[2].id().as_str())
            .env(
                "AGENT_2_PRIVATE_KEY",
                world.agents[2].secret_key().to_string(),
            )
            .env("SETTLER_ACCOUNT_ID", world.alice.id().as_str())
            .env("SETTLER_PRIVATE_KEY", world.alice.secret_key().to_string());
        for (key, value) in extra {
            command.env(key, value);
        }
        command.output().context("spawn worker")
    };
    let first = run(&[])?;
    let stdout = String::from_utf8_lossy(&first.stdout);
    let stderr = String::from_utf8_lossy(&first.stderr);
    if !first.status.success() {
        bail!("worker tick failed\n{stdout}\n{stderr}");
    }
    assert!(
        stdout.contains("offline"),
        "worker should say it used the offline strategy:\n{stdout}"
    );
    let mid = arena(&world.contract).await?;
    assert_eq!(mid["current"]["committed"], json!([true, true, true]));

    wait_until(&world, "reveal").await?;
    let second = run(&[])?;
    let stdout = String::from_utf8_lossy(&second.stdout);
    let stderr = String::from_utf8_lossy(&second.stderr);
    if !second.status.success() {
        bail!("worker reveal/begin failed\n{stdout}\n{stderr}");
    }
    let begun = arena(&world.contract).await?;
    assert_eq!(begun["current"]["settle_begun"], true, "{stdout}");
    assert_eq!(begun["current"]["id"], 0);
    world.worker.fast_forward(1).await?;
    let third = run(&[])?;
    let stdout = String::from_utf8_lossy(&third.stdout);
    let stderr = String::from_utf8_lossy(&third.stderr);
    if !third.status.success() {
        bail!("worker finalize failed\n{stdout}\n{stderr}");
    }
    let done = arena(&world.contract).await?;
    assert_eq!(
        done["current"]["id"], 1,
        "worker should have finalized: {stdout}"
    );
    assert!(
        done["recent_rounds"][0]["winner"].is_number()
            || done["recent_rounds"][0]["winner"].is_null()
    );
    Ok(())
}

fn json_u64(value: &Value) -> Result<u64> {
    if let Some(text) = value.as_str() {
        return Ok(text.parse()?);
    }
    if let Some(number) = value.as_u64() {
        return Ok(number);
    }
    bail!("expected u64, got {value}")
}

fn hex_to_bytes(text: &str) -> Result<Vec<u8>> {
    if text.len() % 2 != 0 {
        return Err(anyhow!("odd hex"));
    }
    (0..text.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&text[index..index + 2], 16).map_err(|err| anyhow!(err)))
        .collect()
}
