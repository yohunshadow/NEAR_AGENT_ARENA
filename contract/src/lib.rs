//! NEAR Agent Arena.
//!
//! Three fighter agents share a contract-escrowed treasury. Players back one
//! during the betting window. An off-chain worker commits `sha256(move || salt
//! || reasoning)` before betting closes and reveals afterwards. `settle` mixes
//! the revealed moves with `env::random_seed()` and opens the next round.
//! Backers claim their own payout; settle never walks the user map.
//!
//! The exact winner rule is documented on [`game`].

mod game;

pub use game::{
    beats, claimable, decide, move_name, mul_div_floor, preimage, validate_reveal, AgentState,
    Decision, Economics, LiveRound, SettledRound, UserBet, FEE_DENOM, MAX_REASONING_BYTES,
    MOVE_AGGRESSIVE, MOVE_BALANCED, MOVE_DEFENSIVE, STATE_BUFFER, STORAGE_BYTE_COST, VERSION,
};

use game::{
    agent_index, apply_back, apply_commit, apply_fund, apply_reveal, apply_settle,
    begin_settle as begin_round, finalize_guard, initial_retired, open_round, phase_of,
    ready_to_settle, start_next_round,
};
use near_sdk::json_types::{U128, U64};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise};

#[near(serializers = [borsh])]
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
struct BetKey {
    round_id: u64,
    account_id: AccountId,
}

#[near(serializers = [json])]
pub struct AgentInit {
    pub account_id: AccountId,
    pub name: String,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub betting_duration_ns: U64,
    pub reveal_duration_ns: U64,
    pub upkeep: U128,
    pub winner_fee_bps: u16,
    pub min_treasury: U128,
    pub storage_byte_cost: U128,
}

#[near(serializers = [json])]
pub struct AgentView {
    pub id: u8,
    pub name: String,
    pub account_id: AccountId,
    pub treasury: U128,
    pub retired: bool,
    pub wins: u64,
    pub rounds_fought: u64,
    pub upkeep_paid: U128,
    pub alive_this_round: bool,
}

#[near(serializers = [json])]
pub struct CurrentRoundView {
    pub id: u64,
    pub phase: String,
    pub ready_to_settle: bool,
    pub ready_to_finalize: bool,
    pub settle_begun: bool,
    pub settle_height: Option<U64>,
    pub block_height: U64,
    pub betting_end_ns: U64,
    pub reveal_end_ns: U64,
    pub pool: U128,
    pub backed: Vec<U128>,
    pub alive: Vec<bool>,
    pub committed: Vec<bool>,
    pub commitment_hex: Vec<Option<String>>,
    pub moves: Vec<Option<u8>>,
    pub reasonings: Vec<Option<String>>,
}

#[near(serializers = [json])]
pub struct SettledRoundView {
    pub id: u64,
    pub winner: Option<u8>,
    pub refund: bool,
    pub pool: U128,
    pub fee: U128,
    pub distributable: U128,
    pub winner_stake: U128,
    pub moves: Vec<Option<u8>>,
    pub reasonings: Vec<Option<String>>,
    pub matchups: Vec<Option<u32>>,
    pub entropies: Vec<Option<u32>>,
    pub scores: Vec<Option<u32>>,
    pub seed_hex: String,
    pub upkeep_charged: Vec<U128>,
    pub settled_at_ns: U64,
}

#[near(serializers = [json])]
pub struct ArenaView {
    pub version: String,
    pub owner_id: AccountId,
    pub now_ns: U64,
    pub protocol_treasury: U128,
    pub config: ConfigView,
    pub agents: Vec<AgentView>,
    pub current: CurrentRoundView,
    pub recent_rounds: Vec<SettledRoundView>,
}

#[near(serializers = [json])]
pub struct UserBetView {
    pub round_id: u64,
    pub stakes: Vec<U128>,
    pub storage_paid: U128,
    pub claimed: bool,
    pub settled: bool,
    pub payout: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    agent_accounts: [AccountId; 3],
    agent_names: [String; 3],
    econ: Economics,
    history: Vector<SettledRound>,
    bets: LookupMap<BetKey, UserBet>,
}

#[near]
impl Contract {
    /// Create the arena.
    ///
    /// Attached deposit, if any, is split across the three agents as their
    /// starting treasury (the remainder goes to agent 0). An agent with an
    /// empty treasury, or one below `min_treasury`, starts retired.
    #[init]
    #[payable]
    pub fn new(
        owner_id: AccountId,
        agents: Vec<AgentInit>,
        betting_duration_ns: U64,
        reveal_duration_ns: U64,
        upkeep: U128,
        winner_fee_bps: u16,
        min_treasury: U128,
    ) -> Self {
        require!(agents.len() == 3, "expected 3 agents");
        require!(winner_fee_bps <= 10_000, "fee bps must be <= 10000");
        require!(
            betting_duration_ns.0 > 0 && reveal_duration_ns.0 > 0,
            "durations must be non-zero"
        );
        let accounts: [AccountId; 3] = [
            agents[0].account_id.clone(),
            agents[1].account_id.clone(),
            agents[2].account_id.clone(),
        ];
        let mut names: [String; 3] = [
            agents[0].name.clone(),
            agents[1].name.clone(),
            agents[2].name.clone(),
        ];
        for i in 0..3 {
            let name = names[i].trim();
            require!(!name.is_empty(), "agent name is empty");
            require!(name.len() <= 32, "agent name is too long");
            names[i] = name.to_string();
        }
        require!(
            accounts[0] != accounts[1] && accounts[0] != accounts[2] && accounts[1] != accounts[2],
            "agent accounts must be unique"
        );

        let total = env::attached_deposit().as_yoctonear();
        let buffer = total.min(STATE_BUFFER);
        let distributable = total - buffer;
        let share = distributable / 3;
        let remainder = distributable % 3;
        let min_treasury = min_treasury.0;
        let mut agent_states = [
            AgentState::default(),
            AgentState::default(),
            AgentState::default(),
        ];
        for i in 0..3 {
            let treasury = share + if i == 0 { remainder } else { 0 };
            agent_states[i].treasury = treasury;
            agent_states[i].retired = initial_retired(treasury, min_treasury);
        }
        let alive = [
            !agent_states[0].retired,
            !agent_states[1].retired,
            !agent_states[2].retired,
        ];
        let now = env::block_timestamp();
        let econ = Economics {
            agents: agent_states,
            round: open_round(0, now, betting_duration_ns.0, reveal_duration_ns.0, alive),
            protocol_treasury: 0,
            upkeep: upkeep.0,
            winner_fee_bps,
            min_treasury,
            betting_duration_ns: betting_duration_ns.0,
            reveal_duration_ns: reveal_duration_ns.0,
        };
        Self {
            owner_id,
            agent_accounts: accounts,
            agent_names: names,
            econ,
            history: Vector::new(b"h"),
            bets: LookupMap::new(b"b"),
        }
    }

    /// Back `agent_id` with the attached deposit. Storage growth is paid out of
    /// the deposit; the rest is the wager. Callable any number of times while
    /// betting is open, including on more than one agent.
    #[payable]
    pub fn back_agent(&mut self, agent_id: u8) {
        let idx = die(agent_index(agent_id));
        let attached = env::attached_deposit().as_yoctonear();
        let pred = env::predecessor_account_id();
        let key = BetKey {
            round_id: self.econ.round.id,
            account_id: pred,
        };
        let before = env::storage_usage();
        let mut bet = self.bets.get(&key).cloned().unwrap_or_default();
        // Insert a same-sized record first so the storage delta is known before
        // the wager is applied. UserBet's Borsh size does not depend on the amounts.
        // LookupMap caches writes until flush, so measure after the trie update.
        self.bets.insert(key.clone(), bet.clone());
        self.bets.flush();
        let grew = env::storage_usage().saturating_sub(before);
        let storage_cost = u128::from(grew) * STORAGE_BYTE_COST;
        die(apply_back(
            &mut self.econ.round,
            &mut bet,
            idx,
            attached,
            storage_cost,
            env::block_timestamp(),
        ));
        self.bets.insert(key, bet);
        emit(
            "back_agent",
            &format!(
                "{{\"round_id\":{},\"agent_id\":{},\"wager\":\"{}\"}}",
                self.econ.round.id, agent_id, self.econ.round.backed[idx]
            ),
        );
    }

    /// Commit `sha256(move_byte || salt_32 || reasoning_utf8)` as 64 hex chars.
    /// Predecessor must be that agent's account. A function-call key limited to
    /// `commit` and `reveal` is enough: this method takes no deposit.
    pub fn commit(&mut self, round_id: U64, commitment_hex: String) {
        let idx = self.caller_agent();
        let commitment = die(parse_hex_32(&commitment_hex));
        die(apply_commit(
            &mut self.econ.round,
            idx,
            round_id.0,
            commitment,
            env::block_timestamp(),
        ));
        emit(
            "commit",
            &format!("{{\"round_id\":{},\"agent_id\":{}}}", round_id.0, idx),
        );
    }

    /// Reveal the preimage. A mismatch does not stick; the agent can retry
    /// until the reveal window ends.
    pub fn reveal(&mut self, round_id: U64, move_id: u8, salt_hex: String, reasoning: String) {
        let idx = self.caller_agent();
        die(validate_reveal(move_id, &reasoning));
        let salt = die(parse_hex_32(&salt_hex));
        let hashed = env::sha256(&preimage(move_id, &salt, &reasoning));
        let mut digest = [0u8; 32];
        digest.copy_from_slice(&hashed);
        die(apply_reveal(
            &mut self.econ.round,
            idx,
            round_id.0,
            move_id,
            &reasoning,
            digest,
            env::block_timestamp(),
        ));
        emit(
            "reveal",
            &format!(
                "{{\"round_id\":{},\"agent_id\":{},\"move_id\":{}}}",
                round_id.0, idx, move_id
            ),
        );
    }

    /// Lock the round for settlement in this block. Does not read the random seed.
    ///
    /// Permissionless once the reveal window has ended, or earlier once every
    /// alive agent who committed has revealed. A second call in a later block,
    /// [`Self::finalize_settle`], reads `env::random_seed()`. The account that
    /// begins settlement cannot choose that seed, because it belongs to a
    /// future block.
    pub fn begin_settle(&mut self) {
        die(begin_round(
            &mut self.econ.round,
            env::block_timestamp(),
            env::block_height(),
        ));
        emit(
            "begin_settle",
            &format!(
                "{{\"round_id\":{},\"block_height\":{}}}",
                self.econ.round.id,
                self.econ.round.settle_height.unwrap_or(0)
            ),
        );
    }

    /// Score the round with this block's `env::random_seed()` and open the next one.
    ///
    /// Fails in the same block as `begin_settle`. Payouts stay on the claim
    /// pattern: this call does not iterate backers.
    pub fn finalize_settle(&mut self) {
        let now = env::block_timestamp();
        die(finalize_guard(&self.econ.round, env::block_height()));
        let seed = env::random_seed_array();
        let settled = die(apply_settle(&mut self.econ, now, seed));
        let round_id = settled.id;
        let winner = settled.winner;
        self.history.push(settled);
        self.history.flush();
        start_next_round(&mut self.econ, now);
        emit(
            "finalize_settle",
            &format!(
                "{{\"round_id\":{},\"winner\":{},\"next_round_id\":{}}}",
                round_id,
                winner
                    .map(|w| w.to_string())
                    .unwrap_or_else(|| "null".to_string()),
                self.econ.round.id
            ),
        );
    }

    /// Send `amount` of an agent's treasury to that agent's own account.
    ///
    /// The predecessor must be the owner or that agent account. Paying the
    /// treasury down to zero retires the agent. During an open betting window
    /// they also leave the current round. Existing bets stay in the pool and
    /// are still claimed individually.
    pub fn withdraw_treasury(&mut self, agent_id: u8, amount: U128) -> Promise {
        let idx = die(agent_index(agent_id));
        let pred = env::predecessor_account_id();
        let agent_account = self.agent_accounts[idx].clone();
        require!(
            pred == self.owner_id || pred == agent_account,
            "owner or agent only"
        );
        let amount = amount.0;
        require!(amount > 0, "amount is zero");
        require!(amount <= self.econ.agents[idx].treasury, "exceeds treasury");
        require!(amount <= liquid_balance(), "exceeds liquid balance");
        self.econ.agents[idx].treasury -= amount;
        if self.econ.agents[idx].treasury == 0 {
            self.econ.agents[idx].retired = true;
            if self.econ.round.settle_height.is_none()
                && env::block_timestamp() < self.econ.round.betting_end_ns
            {
                self.econ.round.alive[idx] = false;
            }
        }
        emit(
            "withdraw_treasury",
            &format!(
                "{{\"agent_id\":{},\"to\":\"{}\",\"amount\":\"{}\",\"treasury\":\"{}\"}}",
                agent_id, agent_account, amount, self.econ.agents[idx].treasury
            ),
        );
        Promise::new(agent_account).transfer(NearToken::from_yoctonear(amount))
    }

    /// Pay the predecessor for `round_id`. Losers and double-claims panic, so a
    /// second transaction cannot move NEAR twice. Settle does not iterate bets;
    /// each backer pulls their own payout or refund.
    pub fn claim(&mut self, round_id: U64) -> Promise {
        let pred = env::predecessor_account_id();
        let key = BetKey {
            round_id: round_id.0,
            account_id: pred.clone(),
        };
        let mut bet = self
            .bets
            .get(&key)
            .cloned()
            .unwrap_or_else(|| env::panic_str("no bet"));
        let settled = self
            .history
            .get(round_id.0 as u32)
            .cloned()
            .unwrap_or_else(|| env::panic_str("round not settled"));
        require!(settled.id == round_id.0, "round not settled");
        let payout = die(claimable(&settled, &bet));
        bet.claimed = true;
        self.bets.insert(key, bet);
        Promise::new(pred).transfer(NearToken::from_yoctonear(payout))
    }

    /// Add the attached deposit to an agent's treasury. A retired agent whose
    /// treasury reaches `min_treasury` is revived. During the betting window
    /// they also join the round in progress.
    #[payable]
    pub fn fund_agent(&mut self, agent_id: u8) {
        let idx = die(agent_index(agent_id));
        let amount = env::attached_deposit().as_yoctonear();
        let revived = die(apply_fund(
            &mut self.econ.agents[idx],
            &mut self.econ.round,
            idx,
            amount,
            self.econ.min_treasury,
            env::block_timestamp(),
        ));
        emit(
            "fund_agent",
            &format!(
                "{{\"agent_id\":{},\"treasury\":\"{}\",\"revived\":{}}}",
                agent_id, self.econ.agents[idx].treasury, revived
            ),
        );
    }

    /// Owner withdraws NEAR collected from agent upkeep.
    pub fn withdraw_protocol(&mut self, amount: U128) -> Promise {
        require!(env::predecessor_account_id() == self.owner_id, "owner only");
        let amount = amount.0;
        require!(amount > 0, "amount is zero");
        require!(
            amount <= self.econ.protocol_treasury,
            "exceeds protocol treasury"
        );
        require!(amount <= liquid_balance(), "exceeds liquid balance");
        self.econ.protocol_treasury -= amount;
        Promise::new(self.owner_id.clone()).transfer(NearToken::from_yoctonear(amount))
    }

    pub fn get_arena(&self) -> ArenaView {
        ArenaView {
            version: VERSION.to_string(),
            owner_id: self.owner_id.clone(),
            now_ns: U64(env::block_timestamp()),
            protocol_treasury: U128(self.econ.protocol_treasury),
            config: self.config_view(),
            agents: self.agent_views(),
            current: self.current_view(),
            recent_rounds: self.recent(5),
        }
    }

    pub fn get_config(&self) -> ConfigView {
        self.config_view()
    }

    pub fn get_agents(&self) -> Vec<AgentView> {
        self.agent_views()
    }

    pub fn get_current_round(&self) -> CurrentRoundView {
        self.current_view()
    }

    pub fn get_recent_rounds(&self, limit: u32) -> Vec<SettledRoundView> {
        self.recent(limit)
    }

    pub fn get_settled_round(&self, round_id: U64) -> Option<SettledRoundView> {
        let len = self.history.len();
        if round_id.0 >= u64::from(len) {
            return None;
        }
        self.history
            .get(round_id.0 as u32)
            .filter(|round| round.id == round_id.0)
            .map(settled_view)
    }

    pub fn get_user_bet(&self, account_id: AccountId, round_id: U64) -> Option<UserBetView> {
        let key = BetKey {
            round_id: round_id.0,
            account_id,
        };
        let bet = self.bets.get(&key)?;
        let settled = self.history.get(round_id.0 as u32).cloned();
        let settled_flag = settled
            .as_ref()
            .map(|round| round.id == round_id.0)
            .unwrap_or(false);
        let payout = if settled_flag {
            claimable(settled.as_ref().expect("settled"), bet).unwrap_or(0)
        } else {
            0
        };
        Some(UserBetView {
            round_id: round_id.0,
            stakes: bet.stakes.iter().copied().map(U128).collect(),
            storage_paid: U128(bet.storage_paid),
            claimed: bet.claimed,
            settled: settled_flag,
            payout: U128(payout),
        })
    }

    /// Hash a reveal the same way `reveal` does, so a worker can check its preimage.
    pub fn preview_commitment(&self, move_id: u8, salt_hex: String, reasoning: String) -> String {
        die(validate_reveal(move_id, &reasoning));
        let salt = die(parse_hex_32(&salt_hex));
        encode_hex(&env::sha256(&preimage(move_id, &salt, &reasoning)))
    }
}

impl Contract {
    fn caller_agent(&self) -> usize {
        let pred = env::predecessor_account_id();
        self.agent_accounts
            .iter()
            .position(|account| account == &pred)
            .unwrap_or_else(|| env::panic_str("caller is not an agent"))
    }

    fn config_view(&self) -> ConfigView {
        ConfigView {
            betting_duration_ns: U64(self.econ.betting_duration_ns),
            reveal_duration_ns: U64(self.econ.reveal_duration_ns),
            upkeep: U128(self.econ.upkeep),
            winner_fee_bps: self.econ.winner_fee_bps,
            min_treasury: U128(self.econ.min_treasury),
            storage_byte_cost: U128(STORAGE_BYTE_COST),
        }
    }

    fn agent_views(&self) -> Vec<AgentView> {
        (0..3)
            .map(|i| AgentView {
                id: i as u8,
                name: self.agent_names[i].clone(),
                account_id: self.agent_accounts[i].clone(),
                treasury: U128(self.econ.agents[i].treasury),
                retired: self.econ.agents[i].retired,
                wins: self.econ.agents[i].wins,
                rounds_fought: self.econ.agents[i].rounds_fought,
                upkeep_paid: U128(self.econ.agents[i].upkeep_paid),
                alive_this_round: self.econ.round.alive[i],
            })
            .collect()
    }

    fn current_view(&self) -> CurrentRoundView {
        let now = env::block_timestamp();
        let height = env::block_height();
        let round = &self.econ.round;
        let begun = round.settle_height;
        CurrentRoundView {
            id: round.id,
            phase: phase_of(round, now).to_string(),
            ready_to_settle: begun.is_none() && ready_to_settle(round, now),
            ready_to_finalize: begun.is_some_and(|started| height > started),
            settle_begun: begun.is_some(),
            settle_height: begun.map(U64),
            block_height: U64(height),
            betting_end_ns: U64(round.betting_end_ns),
            reveal_end_ns: U64(round.reveal_end_ns),
            pool: U128(round.pool),
            backed: round.backed.iter().copied().map(U128).collect(),
            alive: round.alive.to_vec(),
            committed: round.commitments.iter().map(|c| c.is_some()).collect(),
            commitment_hex: round
                .commitments
                .iter()
                .map(|c| c.map(|bytes| encode_hex(&bytes)))
                .collect(),
            moves: round.moves.to_vec(),
            reasonings: round.reasonings.clone().to_vec(),
        }
    }

    fn recent(&self, limit: u32) -> Vec<SettledRoundView> {
        let limit = limit.min(20);
        let len = self.history.len();
        if len == 0 || limit == 0 {
            return Vec::new();
        }
        let start = len.saturating_sub(limit);
        let mut out = Vec::with_capacity((len - start) as usize);
        for index in (start..len).rev() {
            if let Some(round) = self.history.get(index) {
                out.push(settled_view(round));
            }
        }
        out
    }
}

fn settled_view(round: &SettledRound) -> SettledRoundView {
    SettledRoundView {
        id: round.id,
        winner: round.winner,
        refund: round.refund,
        pool: U128(round.pool),
        fee: U128(round.fee),
        distributable: U128(round.distributable),
        winner_stake: U128(round.winner_stake),
        moves: round.moves.to_vec(),
        reasonings: round.reasonings.clone().to_vec(),
        matchups: round.matchups.to_vec(),
        entropies: round.entropies.to_vec(),
        scores: round.scores.to_vec(),
        seed_hex: encode_hex(&round.seed),
        upkeep_charged: round.upkeep_charged.iter().copied().map(U128).collect(),
        settled_at_ns: U64(round.settled_at_ns),
    }
}

fn liquid_balance() -> u128 {
    let balance = env::account_balance().as_yoctonear();
    let locked = u128::from(env::storage_usage()) * STORAGE_BYTE_COST;
    balance.saturating_sub(locked)
}

fn die<T>(result: Result<T, &'static str>) -> T {
    match result {
        Ok(value) => value,
        Err(message) => env::panic_str(message),
    }
}

fn emit(event: &str, data_json: &str) {
    env::log_str(&format!(
        "EVENT_JSON:{{\"standard\":\"near-agent-arena\",\"version\":\"1.0.0\",\"event\":\"{event}\",\"data\":{data_json}}}"
    ));
}

fn parse_hex_32(input: &str) -> Result<[u8; 32], &'static str> {
    let text = input.strip_prefix("0x").unwrap_or(input);
    if text.len() != 64 {
        return Err("expected 64 hex chars");
    }
    let bytes = text.as_bytes();
    let mut out = [0u8; 32];
    for i in 0..32 {
        let hi = hex_val(bytes[i * 2])?;
        let lo = hex_val(bytes[i * 2 + 1])?;
        out[i] = (hi << 4) | lo;
    }
    Ok(out)
}

fn hex_val(byte: u8) -> Result<u8, &'static str> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err("bad hex"),
    }
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod contract_tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{testing_env, NearToken};
    use sha2::{Digest, Sha256};

    fn account(name: &str) -> AccountId {
        name.parse().unwrap()
    }

    fn context(
        predecessor: &str,
        deposit_yocto: u128,
        now: u64,
        seed: [u8; 32],
    ) -> VMContextBuilder {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id(account("arena.test.near"))
            .signer_account_id(account(predecessor))
            .predecessor_account_id(account(predecessor))
            .attached_deposit(NearToken::from_yoctonear(deposit_yocto))
            .account_balance(NearToken::from_near(200))
            .block_timestamp(now)
            .prepaid_gas(near_sdk::Gas::from_tgas(300))
            .random_seed(seed);
        builder
    }

    #[test]
    fn host_sha256_matches_sha2_and_the_commitment_vector() {
        testing_env!(context("arena.test.near", 0, 0, [0u8; 32]).build());
        let salt = [0x11u8; 32];
        let pre = preimage(0, &salt, "hold");
        let host = env::sha256(&pre);
        let lib = Sha256::digest(&pre);
        assert_eq!(host, lib.as_slice());
        assert_eq!(
            encode_hex(&host),
            "16594f519d35ce091c78f92496d035a657d018a79b21e03f5a053a71a33a82d7"
        );
    }

    #[test]
    fn init_splits_deposit_and_views_round_zero() {
        testing_env!(context("owner.test.near", near_to_yocto(6), 1_000, [0u8; 32]).build());
        let contract = Contract::new(
            account("owner.test.near"),
            vec![
                AgentInit {
                    account_id: account("momentum.arena.test.near"),
                    name: "Momentum".to_string(),
                },
                AgentInit {
                    account_id: account("mean.arena.test.near"),
                    name: "Mean-Reversion".to_string(),
                },
                AgentInit {
                    account_id: account("breakout.arena.test.near"),
                    name: "Breakout".to_string(),
                },
            ],
            U64(500),
            U64(500),
            U128(near_to_yocto(1)),
            500,
            U128(near_to_yocto(1)),
        );
        let arena = contract.get_arena();
        assert_eq!(arena.version, "0.1.0");
        assert_eq!(arena.agents.len(), 3);
        assert_eq!(arena.agents[0].name, "Momentum");
        let deposited = near_to_yocto(6);
        let distributable = deposited - STATE_BUFFER;
        assert_eq!(
            arena.agents[0].treasury.0 + arena.agents[1].treasury.0 + arena.agents[2].treasury.0,
            distributable
        );
        assert!(arena.agents[0].treasury.0 >= arena.agents[1].treasury.0);
        assert!(!arena.agents[0].retired);
        assert!(arena.agents[0].alive_this_round);
        assert_eq!(arena.current.phase, "betting");
        assert_eq!(arena.current.id, 0);
        assert!(!arena.current.ready_to_settle);
        let preview = contract.preview_commitment(0, "11".repeat(32), "hold".to_string());
        assert_eq!(
            preview,
            "16594f519d35ce091c78f92496d035a657d018a79b21e03f5a053a71a33a82d7"
        );
    }

    fn near_to_yocto(near: u128) -> u128 {
        near * 10u128.pow(24)
    }

    fn agents() -> Vec<AgentInit> {
        vec![
            AgentInit {
                account_id: account("momentum.arena.test.near"),
                name: "Momentum".to_string(),
            },
            AgentInit {
                account_id: account("mean.arena.test.near"),
                name: "Mean-Reversion".to_string(),
            },
            AgentInit {
                account_id: account("breakout.arena.test.near"),
                name: "Breakout".to_string(),
            },
        ]
    }

    fn commit_hex(move_id: u8, salt: &[u8; 32], reasoning: &str) -> String {
        let hash = Sha256::digest(preimage(move_id, salt, reasoning));
        encode_hex(&hash)
    }

    fn finish_round(contract: &mut Contract, now: u64, seed: [u8; 32]) {
        testing_env!(context("settler.test.near", 0, now, [9u8; 32])
            .block_height(10)
            .build());
        contract.begin_settle();
        let same_block = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.finalize_settle();
        }));
        assert!(same_block.is_err(), "same-block finalize must fail");
        testing_env!(context("settler.test.near", 0, now, seed)
            .block_height(11)
            .build());
        contract.finalize_settle();
    }

    #[test]
    fn contract_round_claim_tie_and_rejects_outsiders() {
        testing_env!(context("owner.test.near", near_to_yocto(7), 1_000, [0u8; 32]).build());
        let mut contract = Contract::new(
            account("owner.test.near"),
            agents(),
            U64(5_000),
            U64(5_000),
            U128(near_to_yocto(1) / 2),
            500,
            U128(near_to_yocto(1)),
        );

        let salts = [[1u8; 32], [2u8; 32], [3u8; 32]];
        let names = [
            "momentum.arena.test.near",
            "mean.arena.test.near",
            "breakout.arena.test.near",
        ];
        let moves = [0u8, 0, 1];
        let reasons = ["trend", "fade", "break"];
        for i in 0..3 {
            testing_env!(context(names[i], 0, 1_200, [0u8; 32]).build());
            contract.commit(U64(0), commit_hex(moves[i], &salts[i], reasons[i]));
        }
        testing_env!(context("alice.test.near", near_to_yocto(2), 1_300, [0u8; 32]).build());
        contract.back_agent(2);
        testing_env!(context("bob.test.near", near_to_yocto(2), 1_400, [0u8; 32]).build());
        contract.back_agent(0);

        testing_env!(context("stranger.test.near", 0, 1_500, [0u8; 32]).build());
        let outsider = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.commit(U64(0), commit_hex(0, &[9u8; 32], "no"));
        }));
        assert!(outsider.is_err());

        for i in 0..3 {
            testing_env!(context(names[i], 0, 7_000, [0u8; 32]).build());
            contract.reveal(
                U64(0),
                moves[i],
                encode_hex(&salts[i]),
                reasons[i].to_string(),
            );
        }
        let mut seed = [0u8; 32];
        seed[0] = 255;
        seed[1] = 255;
        finish_round(&mut contract, 7_100, seed);
        let arena = contract.get_arena();
        assert_eq!(arena.current.id, 1);
        assert_eq!(arena.current.phase, "betting");
        let settled = arena.recent_rounds.first().expect("settled round");
        assert_eq!(settled.winner, Some(2));
        assert_eq!(settled.reasonings[2].as_deref(), Some("break"));
        assert!(settled.fee.0 > 0);
        assert_eq!(arena.agents[2].wins, 1);

        let alice = contract
            .get_user_bet(account("alice.test.near"), U64(0))
            .expect("alice bet");
        assert!(alice.payout.0 > 0);
        assert!(!alice.claimed);
        testing_env!(context("alice.test.near", 0, 7_200, seed).build());
        let _ = contract.claim(U64(0));
        let alice = contract
            .get_user_bet(account("alice.test.near"), U64(0))
            .expect("alice bet");
        assert!(alice.claimed);
        let double = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = contract.claim(U64(0));
        }));
        assert!(double.is_err());

        // Round 1 is a pure score tie: identical moves and a zero seed.
        for i in 0..3 {
            testing_env!(context(names[i], 0, 7_300, [0u8; 32]).build());
            contract.commit(U64(1), commit_hex(1, &salts[i], "same"));
        }
        for i in 0..3 {
            testing_env!(context(names[i], 0, 13_000, [0u8; 32]).build());
            contract.reveal(U64(1), 1, encode_hex(&salts[i]), "same".to_string());
        }
        finish_round(&mut contract, 13_100, [0u8; 32]);
        let tied = contract.get_settled_round(U64(1)).expect("tie round");
        assert_eq!(tied.scores, vec![Some(512), Some(512), Some(512)]);
        assert_eq!(tied.winner, Some(0));
    }

    #[test]
    fn contract_empty_round_retires_and_fund_revives() {
        testing_env!(context("owner.test.near", 0, 1_000, [0u8; 32]).build());
        let mut contract = Contract::new(
            account("owner.test.near"),
            agents(),
            U64(1_000),
            U64(1_000),
            U128(near_to_yocto(1)),
            500,
            U128(near_to_yocto(1)),
        );
        assert!(contract.get_agents().iter().all(|agent| agent.retired));
        let closed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.back_agent(0);
        }));
        assert!(closed.is_err());

        testing_env!(context("patron.test.near", near_to_yocto(1), 1_100, [0u8; 32]).build());
        contract.fund_agent(0);
        assert!(!contract.get_agents()[0].retired);
        assert!(contract.get_current_round().alive[0]);
        testing_env!(context("alice.test.near", near_to_yocto(1), 1_200, [0u8; 32]).build());
        contract.back_agent(0);

        finish_round(&mut contract, 4_000, [0u8; 32]);
        let settled = contract.get_settled_round(U64(0)).expect("empty-ish round");
        assert_eq!(settled.winner, None);
        assert!(settled.refund);
        assert_eq!(contract.get_agents()[0].treasury.0, 0);
        assert!(contract.get_agents()[0].retired);
        assert_eq!(contract.get_arena().current.id, 1);
        assert!(!contract.get_current_round().alive[0]);

        testing_env!(context("alice.test.near", 0, 4_100, [0u8; 32]).build());
        let _ = contract.claim(U64(0));
        let again = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = contract.claim(U64(0));
        }));
        assert!(again.is_err());

        testing_env!(context("patron.test.near", near_to_yocto(1), 4_200, [0u8; 32]).build());
        contract.fund_agent(0);
        assert!(!contract.get_agents()[0].retired);
        assert!(contract.get_current_round().alive[0]);
    }

    #[test]
    fn finalize_uses_the_later_blocks_seed() {
        testing_env!(context("owner.test.near", near_to_yocto(7), 1_000, [0u8; 32]).build());
        let mut contract = Contract::new(
            account("owner.test.near"),
            agents(),
            U64(1_000),
            U64(1_000),
            U128(0),
            500,
            U128(1),
        );
        let salts = [[4u8; 32], [5u8; 32], [6u8; 32]];
        let names = [
            "momentum.arena.test.near",
            "mean.arena.test.near",
            "breakout.arena.test.near",
        ];
        for i in 0..3 {
            testing_env!(context(names[i], 0, 1_100, [0u8; 32]).build());
            contract.commit(U64(0), commit_hex(1, &salts[i], "same"));
        }
        for i in 0..3 {
            testing_env!(context(names[i], 0, 2_200, [0u8; 32]).build());
            contract.reveal(U64(0), 1, encode_hex(&salts[i]), "same".to_string());
        }
        // Begin under a seed that would pick agent 0. Finalize under a seed
        // whose third byte wins the tie.
        testing_env!(context("settler.test.near", 0, 2_300, [0u8; 32])
            .block_height(4)
            .build());
        contract.begin_settle();
        assert_eq!(contract.get_current_round().phase, "finalize");
        assert!(!contract.get_current_round().ready_to_finalize);
        let mut later = [0u8; 32];
        later[2] = 9;
        testing_env!(context("settler.test.near", 0, 2_300, later)
            .block_height(5)
            .build());
        assert!(contract.get_current_round().ready_to_finalize);
        contract.finalize_settle();
        let settled = contract.get_settled_round(U64(0)).expect("settled");
        assert_eq!(settled.winner, Some(2));
        assert_eq!(settled.seed_hex.as_bytes()[4], b'0');
        assert!(settled.seed_hex.starts_with("000009") || settled.entropies[2] == Some(9));
        assert_eq!(settled.entropies[2], Some(9));
    }

    #[test]
    fn owner_or_agent_can_withdraw_treasury_to_the_agent() {
        testing_env!(context("owner.test.near", near_to_yocto(7), 1_000, [0u8; 32]).build());
        let mut contract = Contract::new(
            account("owner.test.near"),
            agents(),
            U64(5_000),
            U64(5_000),
            U128(near_to_yocto(1)),
            500,
            U128(1),
        );
        let before = contract.get_agents()[0].treasury.0;
        testing_env!(context("momentum.arena.test.near", 0, 1_200, [0u8; 32]).build());
        let _ = contract.withdraw_treasury(0, U128(near_to_yocto(1)));
        assert_eq!(
            contract.get_agents()[0].treasury.0,
            before - near_to_yocto(1)
        );
        let receipts = format!("{:?}", near_sdk::test_utils::get_created_receipts());
        assert!(receipts.contains("momentum.arena.test.near"));
        assert!(receipts.contains("Transfer"));

        testing_env!(context("alice.test.near", 0, 1_300, [0u8; 32]).build());
        let stranger = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = contract.withdraw_treasury(0, U128(1));
        }));
        assert!(stranger.is_err());

        testing_env!(context("owner.test.near", 0, 1_400, [0u8; 32]).build());
        let rest = contract.get_agents()[0].treasury.0;
        let _ = contract.withdraw_treasury(0, U128(rest));
        assert_eq!(contract.get_agents()[0].treasury.0, 0);
        assert!(contract.get_agents()[0].retired);
        assert!(!contract.get_current_round().alive[0]);
        let backed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.back_agent(0);
        }));
        assert!(backed.is_err());
    }
}
