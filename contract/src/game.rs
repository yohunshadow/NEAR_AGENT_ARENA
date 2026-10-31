//! Pure round rules for NEAR Agent Arena.
//!
//! No blockchain calls live here. The contract passes in timestamps, the
//! settle-block `random_seed`, and the SHA-256 digest it computed with
//! `env::sha256`. Unit tests drive the same functions the contract calls.
//!
//! # Winner rule
//!
//! Moves are `0` Aggressive, `1` Balanced, `2` Defensive.
//! Move `a` beats move `b` when `(a + 2) % 3 == b`:
//! Aggressive beats Defensive, Defensive beats Balanced, Balanced beats Aggressive.
//!
//! An agent is eligible only if they were alive this round and revealed a
//! preimage that matches their commitment. For every eligible agent `i`:
//!
//! ```text
//! matchup(i) = sum over other eligible j of
//!     2 if i beats j, 1 if the moves tie, 0 if j beats i
//! entropy(i) = random_seed[i]          // one byte, 0..=255
//! score(i)   = matchup(i) * 256 + entropy(i)
//! ```
//!
//! `256` is greater than any entropy byte, so randomness breaks matchup ties
//! and never overturns a matchup lead. The highest score wins. If two scores
//! are equal, the lower agent id wins. That tie-break is total: there is at
//! most one winner whenever anyone revealed.
//!
//! If nobody revealed, there is no winner. A non-zero pool is refunded through
//! `claim`. If the winner has no backers, the whole pool is credited to that
//! agent's treasury (fee and distributable are not split).
//!
//! Otherwise `fee = pool * winner_fee_bps / 10_000` is credited to the winner's
//! treasury and `pool - fee` is claimable by the winner's backers pro-rata.
//! Integer-division dust (strictly less than one yoctoNEAR per backer, and at
//! most `backer_count - 1` yoctoNEAR in total) stays in the contract.
//!
//! Upkeep is charged after the fee, and only from agents who were alive this
//! round. Each pays `min(treasury, upkeep)` into the protocol treasury. A
//! treasury that hits zero retires the agent. Retirement is why a winner's fee
//! is credited before upkeep: the fee can keep a broke winner in the arena.

use near_sdk::near;

pub const MOVE_AGGRESSIVE: u8 = 0;
pub const MOVE_BALANCED: u8 = 1;
pub const MOVE_DEFENSIVE: u8 = 2;
pub const MAX_REASONING_BYTES: usize = 280;
pub const FEE_DENOM: u128 = 10_000;
pub const STORAGE_BYTE_COST: u128 = 10_000_000_000_000_000_000;
/// NEAR withheld from the init deposit so round history can grow without
/// spending an agent's treasury. One NEAR covers on the order of 100 rounds.
pub const STATE_BUFFER: u128 = 1_000_000_000_000_000_000_000_000;
pub const VERSION: &str = "0.1.0";

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentState {
    pub treasury: u128,
    pub retired: bool,
    pub wins: u64,
    pub rounds_fought: u64,
    pub upkeep_paid: u128,
}

impl Default for AgentState {
    fn default() -> Self {
        Self {
            treasury: 0,
            retired: true,
            wins: 0,
            rounds_fought: 0,
            upkeep_paid: 0,
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveRound {
    pub id: u64,
    pub betting_end_ns: u64,
    pub reveal_end_ns: u64,
    pub pool: u128,
    pub backed: [u128; 3],
    pub alive: [bool; 3],
    pub commitments: [Option<[u8; 32]>; 3],
    pub moves: [Option<u8>; 3],
    pub reasonings: [Option<String>; 3],
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettledRound {
    pub id: u64,
    pub winner: Option<u8>,
    pub refund: bool,
    pub pool: u128,
    pub fee: u128,
    pub distributable: u128,
    pub winner_stake: u128,
    pub moves: [Option<u8>; 3],
    pub reasonings: [Option<String>; 3],
    pub matchups: [Option<u32>; 3],
    pub entropies: [Option<u32>; 3],
    pub scores: [Option<u32>; 3],
    pub seed: [u8; 32],
    pub upkeep_charged: [u128; 3],
    pub settled_at_ns: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UserBet {
    pub stakes: [u128; 3],
    pub storage_paid: u128,
    pub claimed: bool,
}

impl Default for UserBet {
    fn default() -> Self {
        Self {
            stakes: [0, 0, 0],
            storage_paid: 0,
            claimed: false,
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Economics {
    pub agents: [AgentState; 3],
    pub round: LiveRound,
    pub protocol_treasury: u128,
    pub upkeep: u128,
    pub winner_fee_bps: u16,
    pub min_treasury: u128,
    pub betting_duration_ns: u64,
    pub reveal_duration_ns: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decision {
    pub winner: Option<u8>,
    pub matchups: [Option<u32>; 3],
    pub entropies: [Option<u32>; 3],
    pub scores: [Option<u32>; 3],
}

pub fn beats(a: u8, b: u8) -> bool {
    (a + 2) % 3 == b
}

pub fn move_name(move_id: u8) -> &'static str {
    match move_id {
        MOVE_AGGRESSIVE => "Aggressive",
        MOVE_BALANCED => "Balanced",
        MOVE_DEFENSIVE => "Defensive",
        _ => "Invalid",
    }
}

pub fn agent_index(agent_id: u8) -> Result<usize, &'static str> {
    if agent_id > 2 {
        Err("unknown agent")
    } else {
        Ok(agent_id as usize)
    }
}

pub fn preimage(move_id: u8, salt: &[u8; 32], reasoning: &str) -> Vec<u8> {
    let bytes = reasoning.as_bytes();
    let mut out = Vec::with_capacity(1 + 32 + bytes.len());
    out.push(move_id);
    out.extend_from_slice(salt);
    out.extend_from_slice(bytes);
    out
}

pub fn validate_reveal(move_id: u8, reasoning: &str) -> Result<(), &'static str> {
    if move_id > 2 {
        return Err("move must be 0, 1, or 2");
    }
    if reasoning.len() > MAX_REASONING_BYTES {
        return Err("reasoning is too long");
    }
    Ok(())
}

pub fn phase_of(round: &LiveRound, now: u64) -> &'static str {
    if now < round.betting_end_ns {
        "betting"
    } else if now < round.reveal_end_ns {
        "reveal"
    } else {
        "settle"
    }
}

pub fn ready_to_settle(round: &LiveRound, now: u64) -> bool {
    if now < round.betting_end_ns {
        return false;
    }
    if now >= round.reveal_end_ns {
        return true;
    }
    (0..3).all(|i| {
        if !round.alive[i] {
            return true;
        }
        if round.commitments[i].is_none() {
            return true;
        }
        round.moves[i].is_some()
    })
}

pub fn open_round(
    id: u64,
    now: u64,
    betting_ns: u64,
    reveal_ns: u64,
    alive: [bool; 3],
) -> LiveRound {
    let betting_end_ns = now.saturating_add(betting_ns);
    LiveRound {
        id,
        betting_end_ns,
        reveal_end_ns: betting_end_ns.saturating_add(reveal_ns),
        pool: 0,
        backed: [0, 0, 0],
        alive,
        commitments: [None, None, None],
        moves: [None, None, None],
        reasonings: [None, None, None],
    }
}

pub fn initial_retired(treasury: u128, min_treasury: u128) -> bool {
    treasury == 0 || treasury < min_treasury
}

pub fn decide(moves: &[Option<u8>; 3], seed: &[u8; 32]) -> Decision {
    let mut matchups = [None; 3];
    let mut entropies = [None; 3];
    let mut scores = [None; 3];
    let eligible: Vec<usize> = (0..3).filter(|&i| moves[i].is_some()).collect();
    for &i in &eligible {
        let mine = moves[i].expect("eligible");
        let mut matchup = 0u32;
        for &j in &eligible {
            if i == j {
                continue;
            }
            let theirs = moves[j].expect("eligible");
            if mine == theirs {
                matchup += 1;
            } else if beats(mine, theirs) {
                matchup += 2;
            }
        }
        let entropy = seed[i] as u32;
        matchups[i] = Some(matchup);
        entropies[i] = Some(entropy);
        scores[i] = Some(matchup * 256 + entropy);
    }
    // Equal scores keep the lower id: we only replace on a strictly higher score
    // and eligible ids are visited in ascending order.
    let mut winner: Option<usize> = None;
    for &i in &eligible {
        let score = scores[i].expect("scored");
        let replace = match winner {
            None => true,
            Some(best) => score > scores[best].expect("scored"),
        };
        if replace {
            winner = Some(i);
        }
    }
    Decision {
        winner: winner.map(|i| i as u8),
        matchups,
        entropies,
        scores,
    }
}

pub fn apply_back(
    round: &mut LiveRound,
    bet: &mut UserBet,
    agent_index: usize,
    attached: u128,
    storage_cost: u128,
    now: u64,
) -> Result<(), &'static str> {
    if now >= round.betting_end_ns {
        return Err("betting is closed");
    }
    if !round.alive[agent_index] {
        return Err("agent is not in this round");
    }
    if attached == 0 {
        return Err("attach NEAR to back an agent");
    }
    if attached <= storage_cost {
        return Err("deposit does not cover storage and a wager");
    }
    let wager = attached - storage_cost;
    bet.stakes[agent_index] = bet.stakes[agent_index]
        .checked_add(wager)
        .ok_or("stake overflow")?;
    bet.storage_paid = bet
        .storage_paid
        .checked_add(storage_cost)
        .ok_or("storage overflow")?;
    round.pool = round.pool.checked_add(wager).ok_or("pool overflow")?;
    round.backed[agent_index] = round.backed[agent_index]
        .checked_add(wager)
        .ok_or("backed overflow")?;
    Ok(())
}

pub fn apply_commit(
    round: &mut LiveRound,
    agent_index: usize,
    round_id: u64,
    commitment: [u8; 32],
    now: u64,
) -> Result<(), &'static str> {
    if round.id != round_id {
        return Err("stale round");
    }
    if now >= round.betting_end_ns {
        return Err("commit during betting only");
    }
    if !round.alive[agent_index] {
        return Err("agent is not in this round");
    }
    if round.commitments[agent_index].is_some() {
        return Err("already committed");
    }
    round.commitments[agent_index] = Some(commitment);
    Ok(())
}

pub fn apply_reveal(
    round: &mut LiveRound,
    agent_index: usize,
    round_id: u64,
    move_id: u8,
    reasoning: &str,
    digest: [u8; 32],
    now: u64,
) -> Result<(), &'static str> {
    if round.id != round_id {
        return Err("stale round");
    }
    if now < round.betting_end_ns || now >= round.reveal_end_ns {
        return Err("reveal during the reveal window");
    }
    if !round.alive[agent_index] {
        return Err("agent is not in this round");
    }
    let expected = round.commitments[agent_index].ok_or("nothing to reveal")?;
    if expected != digest {
        return Err("commitment mismatch");
    }
    if round.moves[agent_index].is_some() {
        return Err("already revealed");
    }
    validate_reveal(move_id, reasoning)?;
    round.moves[agent_index] = Some(move_id);
    round.reasonings[agent_index] = Some(reasoning.to_string());
    Ok(())
}

pub fn apply_fund(
    agent: &mut AgentState,
    round: &mut LiveRound,
    agent_index: usize,
    amount: u128,
    min_treasury: u128,
    now: u64,
) -> Result<bool, &'static str> {
    if amount == 0 {
        return Err("attach NEAR to fund an agent");
    }
    agent.treasury = agent
        .treasury
        .checked_add(amount)
        .ok_or("treasury overflow")?;
    let mut revived = false;
    if agent.retired && agent.treasury >= min_treasury && agent.treasury > 0 {
        agent.retired = false;
        revived = true;
        if now < round.betting_end_ns {
            round.alive[agent_index] = true;
        }
    }
    Ok(revived)
}

pub fn apply_settle(
    econ: &mut Economics,
    now: u64,
    seed: [u8; 32],
) -> Result<SettledRound, &'static str> {
    if !ready_to_settle(&econ.round, now) {
        return Err("round is not ready to settle");
    }

    let mut moves = [None; 3];
    let mut reasonings: [Option<String>; 3] = [None, None, None];
    for i in 0..3 {
        if econ.round.alive[i] {
            moves[i] = econ.round.moves[i];
            if moves[i].is_some() {
                reasonings[i] = econ.round.reasonings[i].clone();
            }
        }
    }
    let decision = decide(&moves, &seed);
    let pool = econ.round.pool;
    let winner = decision.winner;
    let winner_stake = winner.map(|w| econ.round.backed[w as usize]).unwrap_or(0);

    let (fee, distributable, refund) = if let Some(w) = winner {
        let idx = w as usize;
        if pool == 0 {
            (0u128, 0u128, false)
        } else if winner_stake == 0 {
            econ.agents[idx].treasury = econ.agents[idx]
                .treasury
                .checked_add(pool)
                .ok_or("treasury overflow")?;
            (pool, 0, false)
        } else {
            let fee = pool
                .checked_mul(u128::from(econ.winner_fee_bps))
                .ok_or("fee overflow")?
                / FEE_DENOM;
            let distributable = pool - fee;
            econ.agents[idx].treasury = econ.agents[idx]
                .treasury
                .checked_add(fee)
                .ok_or("treasury overflow")?;
            (fee, distributable, false)
        }
    } else {
        (0, 0, pool > 0)
    };

    if let Some(w) = winner {
        econ.agents[w as usize].wins = econ.agents[w as usize].wins.saturating_add(1);
    }

    let mut upkeep_charged = [0u128; 3];
    for i in 0..3 {
        if !econ.round.alive[i] {
            continue;
        }
        econ.agents[i].rounds_fought = econ.agents[i].rounds_fought.saturating_add(1);
        let treasury = econ.agents[i].treasury;
        let charged = treasury.min(econ.upkeep);
        econ.agents[i].treasury = treasury - charged;
        econ.agents[i].upkeep_paid = econ.agents[i]
            .upkeep_paid
            .checked_add(charged)
            .ok_or("upkeep overflow")?;
        econ.protocol_treasury = econ
            .protocol_treasury
            .checked_add(charged)
            .ok_or("protocol overflow")?;
        upkeep_charged[i] = charged;
        if econ.agents[i].treasury == 0 {
            econ.agents[i].retired = true;
        }
    }

    Ok(SettledRound {
        id: econ.round.id,
        winner,
        refund,
        pool,
        fee,
        distributable,
        winner_stake,
        moves,
        reasonings,
        matchups: decision.matchups,
        entropies: decision.entropies,
        scores: decision.scores,
        seed,
        upkeep_charged,
        settled_at_ns: now,
    })
}

pub fn claimable(settled: &SettledRound, bet: &UserBet) -> Result<u128, &'static str> {
    if bet.claimed {
        return Err("already claimed");
    }
    let payout = if settled.refund {
        bet.stakes
            .iter()
            .fold(0u128, |acc, stake| acc.saturating_add(*stake))
    } else if let Some(w) = settled.winner {
        if settled.winner_stake == 0 {
            0
        } else {
            mul_div_floor(
                bet.stakes[w as usize],
                settled.distributable,
                settled.winner_stake,
            )
        }
    } else {
        0
    };
    if payout == 0 {
        return Err("nothing to claim");
    }
    Ok(payout)
}

/// `floor(a * b / denom)` with a 256-bit intermediate.
///
/// A backer's stake on the winner is at most `winner_stake` (`denom`), so the
/// quotient fits in `u128`.
pub fn mul_div_floor(a: u128, b: u128, denom: u128) -> u128 {
    if a == 0 || b == 0 {
        return 0;
    }
    assert!(denom != 0, "mul_div denom is zero");
    let (hi, lo) = mul_wide(a, b);
    div_wide(hi, lo, denom)
}

fn mul_wide(a: u128, b: u128) -> (u128, u128) {
    const MASK: u128 = (1u128 << 64) - 1;
    let a0 = a & MASK;
    let a1 = a >> 64;
    let b0 = b & MASK;
    let b1 = b >> 64;
    let ll = a0 * b0;
    let lh = a0 * b1;
    let hl = a1 * b0;
    let hh = a1 * b1;
    let ll_lo = ll & MASK;
    let ll_hi = ll >> 64;
    let (sum, carry0) = lh.overflowing_add(hl);
    let (mid, carry1) = sum.overflowing_add(ll_hi);
    let carry = u128::from(carry0) + u128::from(carry1);
    let lo = (mid << 64) | ll_lo;
    let hi = hh + (mid >> 64) + (carry << 64);
    (hi, lo)
}

/// Divide the 256-bit value `(hi << 128) | lo` by `denom`.
///
/// `hi < denom` whenever the quotient fits in `u128`, which holds for payouts
/// because a backer's stake is at most the winner's stake.
fn div_wide(hi: u128, lo: u128, denom: u128) -> u128 {
    if hi == 0 {
        return lo / denom;
    }
    assert!(
        hi < denom,
        "mul_div quotient does not fit hi={hi} lo={lo} denom={denom}"
    );
    let mut remainder: u128 = 0;
    let mut quotient: u128 = 0;
    for step in 0..256 {
        let src_bit_index = 255 - step;
        let bit = if src_bit_index >= 128 {
            (hi >> (src_bit_index - 128)) & 1
        } else {
            (lo >> src_bit_index) & 1
        };
        // `overflowing_shl` only flags a too-large shift count, not a lost high
        // bit, so the carry is tested directly. `wrapping_shl` keeps debug
        // overflow checks from aborting the step.
        let carry = remainder >> 127;
        let shifted = remainder.wrapping_shl(1);
        if carry == 1 {
            // True remainder is `2^128 + shifted`. That exceeds any `denom`,
            // and the low limb is smaller than `denom`, so one wrapping
            // subtract clears the extra high bit.
            remainder = (shifted | bit).wrapping_sub(denom);
            if src_bit_index < 128 {
                quotient |= 1u128 << src_bit_index;
            }
        } else {
            remainder = shifted | bit;
            if remainder >= denom {
                remainder -= denom;
                if src_bit_index < 128 {
                    quotient |= 1u128 << src_bit_index;
                }
            }
        }
    }
    quotient
}

pub fn start_next_round(econ: &mut Economics, now: u64) {
    let next_id = econ.round.id.saturating_add(1);
    let alive = [
        !econ.agents[0].retired,
        !econ.agents[1].retired,
        !econ.agents[2].retired,
    ];
    econ.round = open_round(
        next_id,
        now,
        econ.betting_duration_ns,
        econ.reveal_duration_ns,
        alive,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::collections::BTreeMap;

    fn digest(move_id: u8, salt: &[u8; 32], reasoning: &str) -> [u8; 32] {
        let hash = Sha256::digest(preimage(move_id, salt, reasoning));
        let mut out = [0u8; 32];
        out.copy_from_slice(&hash);
        out
    }

    fn econ(upkeep: u128, treasury: u128, min_treasury: u128) -> Economics {
        let mut agents = [
            AgentState::default(),
            AgentState::default(),
            AgentState::default(),
        ];
        for agent in &mut agents {
            agent.treasury = treasury;
            agent.retired = initial_retired(treasury, min_treasury);
        }
        let alive = [!agents[0].retired, !agents[1].retired, !agents[2].retired];
        Economics {
            agents,
            round: open_round(0, 1_000, 500, 500, alive),
            protocol_treasury: 0,
            upkeep,
            winner_fee_bps: 500,
            min_treasury,
            betting_duration_ns: 500,
            reveal_duration_ns: 500,
        }
    }

    struct Sim {
        econ: Economics,
        bets: BTreeMap<(u64, String), UserBet>,
        history: Vec<SettledRound>,
    }

    impl Sim {
        fn new(upkeep: u128, treasury: u128, min_treasury: u128) -> Self {
            Self {
                econ: econ(upkeep, treasury, min_treasury),
                bets: BTreeMap::new(),
                history: Vec::new(),
            }
        }

        fn back(&mut self, user: &str, agent: u8, amount: u128, now: u64) {
            let idx = agent_index(agent).unwrap();
            let key = (self.econ.round.id, user.to_string());
            let mut bet = self.bets.get(&key).cloned().unwrap_or_default();
            apply_back(&mut self.econ.round, &mut bet, idx, amount, 0, now).unwrap();
            self.bets.insert(key, bet);
        }

        fn commit(&mut self, agent: u8, commitment: [u8; 32], now: u64) {
            let id = self.econ.round.id;
            apply_commit(&mut self.econ.round, agent as usize, id, commitment, now).unwrap();
        }

        fn reveal(&mut self, agent: u8, move_id: u8, salt: &[u8; 32], reasoning: &str, now: u64) {
            let id = self.econ.round.id;
            let digest = digest(move_id, salt, reasoning);
            apply_reveal(
                &mut self.econ.round,
                agent as usize,
                id,
                move_id,
                reasoning,
                digest,
                now,
            )
            .unwrap();
        }

        fn settle(&mut self, now: u64, seed: [u8; 32]) -> SettledRound {
            let settled = apply_settle(&mut self.econ, now, seed).unwrap();
            start_next_round(&mut self.econ, now);
            self.history.push(settled.clone());
            settled
        }

        fn claim(&mut self, user: &str, round_id: u64) -> Result<u128, &'static str> {
            let settled = self
                .history
                .iter()
                .find(|r| r.id == round_id)
                .cloned()
                .ok_or("round not settled")?;
            let key = (round_id, user.to_string());
            let mut bet = self.bets.get(&key).cloned().ok_or("no bet")?;
            let payout = claimable(&settled, &bet)?;
            bet.claimed = true;
            self.bets.insert(key, bet);
            Ok(payout)
        }

        fn fund(&mut self, agent: u8, amount: u128, now: u64) -> bool {
            apply_fund(
                &mut self.econ.agents[agent as usize],
                &mut self.econ.round,
                agent as usize,
                amount,
                self.econ.min_treasury,
                now,
            )
            .unwrap()
        }
    }

    #[test]
    fn commitment_vector_matches_sha256() {
        let salt = [0x11u8; 32];
        let pre = preimage(0, &salt, "hold");
        assert_eq!(
            hex::encode(&pre),
            "001111111111111111111111111111111111111111111111111111111111111111686f6c64"
        );
        assert_eq!(
            hex::encode(digest(0, &salt, "hold")),
            "16594f519d35ce091c78f92496d035a657d018a79b21e03f5a053a71a33a82d7"
        );
    }

    #[test]
    fn beats_is_a_cycle() {
        assert!(beats(0, 2));
        assert!(beats(2, 1));
        assert!(beats(1, 0));
        assert!(!beats(0, 1));
        assert!(!beats(0, 0));
        assert_eq!(move_name(0), "Aggressive");
        assert_eq!(move_name(1), "Balanced");
        assert_eq!(move_name(2), "Defensive");
    }

    #[test]
    fn matchup_lead_beats_any_entropy() {
        // Balanced beats both Aggressives. Entropy is maxed on the losers.
        let moves = [Some(0), Some(0), Some(1)];
        let mut seed = [0u8; 32];
        seed[0] = 255;
        seed[1] = 255;
        seed[2] = 0;
        let d = decide(&moves, &seed);
        assert_eq!(d.matchups, [Some(1), Some(1), Some(4)]);
        assert_eq!(d.winner, Some(2));
        assert!(d.scores[2].unwrap() > d.scores[0].unwrap());
    }

    #[test]
    fn identical_moves_and_seed_tie_break_to_lowest_id() {
        let moves = [Some(1), Some(1), Some(1)];
        let d = decide(&moves, &[0u8; 32]);
        assert_eq!(d.matchups, [Some(2), Some(2), Some(2)]);
        assert_eq!(d.scores, [Some(512), Some(512), Some(512)]);
        assert_eq!(d.winner, Some(0));
    }

    #[test]
    fn identical_moves_entropy_picks_higher_byte_then_lower_id() {
        let moves = [Some(2), Some(2), Some(2)];
        let mut seed = [0u8; 32];
        seed[0] = 4;
        seed[1] = 9;
        seed[2] = 9;
        let d = decide(&moves, &seed);
        assert_eq!(d.winner, Some(1));
        seed[1] = 9;
        seed[2] = 8;
        let d = decide(&moves, &seed);
        assert_eq!(d.winner, Some(1));
        seed[0] = 9;
        seed[1] = 9;
        seed[2] = 9;
        assert_eq!(decide(&moves, &seed).winner, Some(0));
    }

    #[test]
    fn no_reveals_has_no_winner() {
        let d = decide(&[None, None, None], &[7u8; 32]);
        assert_eq!(d.winner, None);
    }

    #[test]
    fn solo_reveal_wins() {
        let d = decide(&[None, Some(0), None], &[0u8; 32]);
        assert_eq!(d.winner, Some(1));
        assert_eq!(d.matchups[1], Some(0));
    }

    #[test]
    fn full_round_pays_winner_backers_and_fee_before_upkeep() {
        let mut sim = Sim::new(100, 10_000, 100);
        let salt0 = [1u8; 32];
        let salt1 = [2u8; 32];
        let salt2 = [3u8; 32];
        sim.commit(0, digest(0, &salt0, "trend"), 1_100);
        sim.commit(1, digest(0, &salt1, "fade"), 1_100);
        sim.commit(2, digest(1, &salt2, "break"), 1_100);
        sim.back("alice", 2, 2_000, 1_100);
        sim.back("bob", 0, 2_000, 1_200);
        assert_eq!(sim.econ.round.pool, 4_000);
        // Still in betting: settle is refused.
        assert!(apply_settle(&mut sim.econ, 1_200, [0u8; 32]).is_err());
        sim.reveal(0, 0, &salt0, "trend", 1_600);
        sim.reveal(1, 0, &salt1, "fade", 1_600);
        sim.reveal(2, 1, &salt2, "break", 1_700);
        let mut seed = [0u8; 32];
        seed[0] = 255;
        seed[1] = 255;
        let settled = sim.settle(1_700, seed);
        assert_eq!(settled.winner, Some(2));
        assert!(!settled.refund);
        assert_eq!(settled.fee, 200);
        assert_eq!(settled.distributable, 3_800);
        assert_eq!(settled.winner_stake, 2_000);
        assert_eq!(settled.reasonings[2].as_deref(), Some("break"));
        // Fee +200 then upkeep -100.
        assert_eq!(sim.econ.agents[2].treasury, 10_100);
        assert_eq!(sim.econ.agents[0].treasury, 9_900);
        assert_eq!(sim.econ.agents[1].treasury, 9_900);
        assert_eq!(sim.econ.agents[2].wins, 1);
        assert_eq!(sim.econ.protocol_treasury, 300);
        assert!(!sim.econ.agents[2].retired);
        assert_eq!(sim.econ.round.id, 1);
        assert_eq!(phase_of(&sim.econ.round, 1_700), "betting");
        assert_eq!(sim.claim("alice", 0).unwrap(), 3_800);
        assert_eq!(sim.claim("bob", 0).unwrap_err(), "nothing to claim");
        assert_eq!(sim.claim("alice", 0).unwrap_err(), "already claimed");
        assert!(sim.claim("carol", 0).is_err());
    }

    #[test]
    fn tie_on_equal_scores_pays_lowest_id() {
        let mut sim = Sim::new(0, 1_000, 1);
        let salts = [[9u8; 32], [8u8; 32], [7u8; 32]];
        for i in 0..3 {
            sim.commit(i as u8, digest(1, &salts[i], "same"), 1_100);
        }
        sim.back("alice", 0, 3_000, 1_100);
        sim.back("bob", 1, 3_000, 1_100);
        sim.back("carol", 2, 3_000, 1_100);
        for i in 0..3 {
            sim.reveal(i as u8, 1, &salts[i], "same", 1_600);
        }
        let settled = sim.settle(1_600, [0u8; 32]);
        assert_eq!(settled.scores, [Some(512), Some(512), Some(512)]);
        assert_eq!(settled.winner, Some(0));
        // pool 9000, fee 5% = 450, distributable 8550, winner stake 3000.
        assert_eq!(settled.fee, 450);
        assert_eq!(settled.distributable, 8_550);
        assert_eq!(sim.claim("alice", 0).unwrap(), 8_550);
        assert_eq!(sim.claim("alice", 0).unwrap_err(), "already claimed");
        assert_eq!(sim.claim("bob", 0).unwrap_err(), "nothing to claim");
    }

    #[test]
    fn empty_round_charges_upkeep_and_opens_the_next_round() {
        let mut sim = Sim::new(400, 1_000, 100);
        assert!(ready_to_settle(&sim.econ.round, 1_499) == false);
        assert!(ready_to_settle(&sim.econ.round, 1_500));
        let settled = sim.settle(2_200, [3u8; 32]);
        assert_eq!(settled.pool, 0);
        assert_eq!(settled.winner, None);
        assert!(!settled.refund);
        assert_eq!(settled.fee, 0);
        assert_eq!(sim.econ.protocol_treasury, 1_200);
        assert_eq!(sim.econ.agents[0].treasury, 600);
        assert_eq!(sim.econ.agents[0].rounds_fought, 1);
        assert_eq!(sim.econ.agents[0].wins, 0);
        assert_eq!(sim.econ.round.id, 1);
        assert!(sim.econ.round.alive.iter().all(|a| *a));
    }

    #[test]
    fn retire_when_upkeep_drains_treasury_and_revive_on_fund() {
        let mut sim = Sim::new(500, 500, 500);
        assert!(sim.econ.round.alive.iter().all(|a| *a));
        let settled = sim.settle(2_200, [0u8; 32]);
        assert_eq!(settled.upkeep_charged, [500, 500, 500]);
        assert!(sim.econ.agents.iter().all(|a| a.retired && a.treasury == 0));
        assert!(sim.econ.round.alive.iter().all(|a| !*a));
        assert_eq!(sim.econ.protocol_treasury, 1_500);
        // Dust under the revive threshold does not bring them back.
        assert!(!sim.fund(1, 499, 2_300));
        assert!(sim.econ.agents[1].retired);
        let err = apply_back(
            &mut sim.econ.round,
            &mut UserBet::default(),
            1,
            10,
            0,
            2_300,
        );
        assert_eq!(err.unwrap_err(), "agent is not in this round");
        assert!(sim.fund(1, 1, 2_300));
        assert!(!sim.econ.agents[1].retired);
        assert!(sim.econ.round.alive[1]);
        assert_eq!(sim.econ.agents[1].treasury, 500);
        sim.back("alice", 1, 50, 2_300);
        assert_eq!(sim.econ.round.backed[1], 50);
        // Funding during reveal does not pull a retired agent into the current round.
        // 2800 is inside the next round's reveal window, so a revive waits.
        assert!(sim.fund(0, 500, 2_800));
        assert!(!sim.econ.agents[0].retired);
        assert!(!sim.econ.round.alive[0]);
    }

    #[test]
    fn bets_with_no_reveal_are_refunded_once() {
        let mut sim = Sim::new(0, 100, 1);
        sim.back("alice", 0, 80, 1_100);
        sim.back("alice", 2, 20, 1_100);
        sim.back("bob", 1, 40, 1_100);
        let settled = sim.settle(2_200, [1u8; 32]);
        assert_eq!(settled.winner, None);
        assert!(settled.refund);
        assert_eq!(sim.claim("alice", 0).unwrap(), 100);
        assert_eq!(sim.claim("alice", 0).unwrap_err(), "already claimed");
        assert_eq!(sim.claim("bob", 0).unwrap(), 40);
    }

    #[test]
    fn winner_with_no_backers_keeps_the_pool() {
        let mut sim = Sim::new(0, 1_000, 1);
        let salt = [4u8; 32];
        sim.commit(0, digest(0, &salt, "solo"), 1_100);
        sim.back("alice", 1, 777, 1_100);
        sim.reveal(0, 0, &salt, "solo", 1_600);
        let settled = sim.settle(1_600, [0u8; 32]);
        assert_eq!(settled.winner, Some(0));
        assert_eq!(settled.winner_stake, 0);
        assert_eq!(settled.fee, 777);
        assert_eq!(settled.distributable, 0);
        assert_eq!(sim.econ.agents[0].treasury, 1_777);
        assert_eq!(sim.claim("alice", 0).unwrap_err(), "nothing to claim");
    }

    #[test]
    fn pro_rata_dust_is_left_behind() {
        let mut settled = SettledRound {
            id: 0,
            winner: Some(0),
            refund: false,
            pool: 3_000,
            fee: 0,
            distributable: 1_000,
            winner_stake: 3_000,
            moves: [Some(0), None, None],
            reasonings: [None, None, None],
            matchups: [None, None, None],
            entropies: [None, None, None],
            scores: [None, None, None],
            seed: [0u8; 32],
            upkeep_charged: [0, 0, 0],
            settled_at_ns: 0,
        };
        let mut bets = [UserBet::default(), UserBet::default(), UserBet::default()];
        for bet in &mut bets {
            bet.stakes[0] = 1_000;
        }
        let payouts: Vec<u128> = bets
            .iter()
            .map(|b| claimable(&settled, b).unwrap())
            .collect();
        assert_eq!(payouts, vec![333, 333, 333]);
        assert_eq!(1_000 - payouts.iter().sum::<u128>(), 1);
        settled.distributable = 0;
        // A second claim on the same bet is rejected even when we only marked one.
        bets[0].claimed = true;
        assert_eq!(
            claimable(&settled, &bets[0]).unwrap_err(),
            "already claimed"
        );
    }

    #[test]
    fn mul_div_matches_wide_products() {
        assert_eq!(mul_div_floor(2_000, 3_800, 2_000), 3_800);
        assert_eq!(mul_div_floor(1_000, 1_000, 3_000), 333);
        assert_eq!(mul_div_floor(0, 5, 1), 0);
        let big = 10u128.pow(30);
        assert_eq!(mul_div_floor(big, big, big), big);
        assert_eq!(mul_div_floor(u128::MAX, 2, 2), u128::MAX);
        assert_eq!(mul_div_floor(u128::MAX, u128::MAX, u128::MAX), u128::MAX);
        assert_eq!(
            mul_div_floor(10u128.pow(30), 10u128.pow(24), 10u128.pow(24)),
            10u128.pow(30)
        );
        assert_eq!(
            mul_div_floor(10u128.pow(24), 10u128.pow(24), 10u128.pow(20)),
            10u128.pow(28)
        );
    }

    #[test]
    fn early_settle_when_every_commitment_is_revealed() {
        let mut sim = Sim::new(0, 100, 1);
        let salt = [5u8; 32];
        sim.commit(0, digest(2, &salt, "a"), 1_100);
        assert!(!ready_to_settle(&sim.econ.round, 1_500));
        sim.reveal(0, 2, &salt, "a", 1_500);
        // Agents 1 and 2 never committed, so the round can settle inside the window.
        assert!(ready_to_settle(&sim.econ.round, 1_500));
        let settled = sim.settle(1_500, [0u8; 32]);
        assert_eq!(settled.winner, Some(0));
    }

    #[test]
    fn bad_reveal_does_not_stick() {
        let mut round = open_round(0, 0, 100, 100, [true, false, false]);
        let salt = [6u8; 32];
        let commitment = digest(0, &salt, "ok");
        apply_commit(&mut round, 0, 0, commitment, 10).unwrap();
        let err = apply_reveal(&mut round, 0, 0, 0, "ok", [9u8; 32], 150);
        assert_eq!(err.unwrap_err(), "commitment mismatch");
        assert!(round.moves[0].is_none());
        apply_reveal(&mut round, 0, 0, 0, "ok", commitment, 150).unwrap();
        assert_eq!(
            apply_reveal(&mut round, 0, 0, 0, "ok", commitment, 150).unwrap_err(),
            "already revealed"
        );
    }

    #[test]
    fn rejects_double_commit_and_closed_betting() {
        let mut round = open_round(3, 0, 100, 100, [true, true, true]);
        apply_commit(&mut round, 0, 3, [1u8; 32], 10).unwrap();
        assert_eq!(
            apply_commit(&mut round, 0, 3, [2u8; 32], 11).unwrap_err(),
            "already committed"
        );
        assert_eq!(
            apply_commit(&mut round, 1, 2, [2u8; 32], 11).unwrap_err(),
            "stale round"
        );
        assert_eq!(
            apply_commit(&mut round, 1, 3, [2u8; 32], 100).unwrap_err(),
            "commit during betting only"
        );
        assert_eq!(
            apply_back(&mut round, &mut UserBet::default(), 1, 5, 0, 100).unwrap_err(),
            "betting is closed"
        );
    }
}
