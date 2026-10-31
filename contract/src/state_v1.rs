//! Borsh layout of the contract deployed before schema 2.
//!
//! The live testnet account `near-agent-arena-97b380.testnet` was initialized
//! with this layout (no per-round upkeep snapshot, no `schema_version`).
//! `Contract::migrate` decodes these bytes and writes the current `Contract`.
//! Collection prefixes stay `b"h"` and `b"b"`, so history and bets move with
//! the handles instead of being copied.

use crate::game::{AgentState, SettledRound, UserBet};
use crate::BetKey;
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{near, AccountId};

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveRoundV1 {
    pub id: u64,
    pub betting_end_ns: u64,
    pub reveal_end_ns: u64,
    pub pool: u128,
    pub backed: [u128; 3],
    pub alive: [bool; 3],
    pub commitments: [Option<[u8; 32]>; 3],
    pub moves: [Option<u8>; 3],
    pub reasonings: [Option<String>; 3],
    pub settle_height: Option<u64>,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EconomicsV1 {
    pub agents: [AgentState; 3],
    pub round: LiveRoundV1,
    pub protocol_treasury: u128,
    pub upkeep: u128,
    pub winner_fee_bps: u16,
    pub min_treasury: u128,
    pub betting_duration_ns: u64,
    pub reveal_duration_ns: u64,
}

#[near(serializers = [borsh])]
pub struct ContractV1 {
    pub owner_id: AccountId,
    pub agent_accounts: [AccountId; 3],
    pub agent_names: [String; 3],
    pub econ: EconomicsV1,
    pub history: Vector<SettledRound>,
    pub bets: LookupMap<BetKey, UserBet>,
}
