import { setupBitteWallet } from "@near-wallet-selector/bitte-wallet";
import { setupBitgetWallet } from "@near-wallet-selector/bitget-wallet";
import { setupCoin98Wallet } from "@near-wallet-selector/coin98-wallet";
import { setupHereWallet } from "@near-wallet-selector/here-wallet";
import { setupHotWallet } from "@near-wallet-selector/hot-wallet";
import { setupMathWallet } from "@near-wallet-selector/math-wallet";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupMeteorWalletApp } from "@near-wallet-selector/meteor-wallet-app";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { setupNarwallets } from "@near-wallet-selector/narwallets";
import { setupNearFi } from "@near-wallet-selector/nearfi";
import { setupNearMobileWallet } from "@near-wallet-selector/near-mobile-wallet";
import { setupNeth } from "@near-wallet-selector/neth";
import { setupNightly } from "@near-wallet-selector/nightly";
import { setupOKXWallet } from "@near-wallet-selector/okx-wallet";
import { setupRamperWallet } from "@near-wallet-selector/ramper-wallet";
import { setupSender } from "@near-wallet-selector/sender";
import { setupWelldoneWallet } from "@near-wallet-selector/welldone-wallet";
import { setupXDEFI } from "@near-wallet-selector/xdefi";

/**
 * Testnet modules from @near-wallet-selector 8.10.2, the version already used
 * here. Bitte reads the selector network and opens testnet.wallet.bitte.ai.
 * Meteor's mobile app needs the arena contract id for its limited-access key;
 * the modal hides that instant-link entry until it is the selected wallet.
 * NearFi only registers when its extension is installed.
 *
 * Left out of this 8.10.2 set: Intear (no 8.10 release), Ledger (hid-framing
 * export breaks the Next build), Near Snap (pulls Node fs), WalletConnect
 * (needs a project id), and Ethereum wallets (need wagmi). Mintbase is the
 * same SDK as Bitte.
 */
export function testnetWalletModules(contractId: string) {
  return [
    setupMyNearWallet(),
    setupMeteorWallet(),
    setupMeteorWalletApp({ contractId }),
    setupHereWallet(),
    setupSender(),
    setupHotWallet(),
    setupNightly(),
    setupOKXWallet(),
    setupBitgetWallet(),
    setupCoin98Wallet(),
    setupMathWallet(),
    setupWelldoneWallet(),
    setupXDEFI(),
    setupNearFi(),
    setupRamperWallet(),
    setupNarwallets(),
    setupNeth({ gas: "300000000000000", bundle: false }),
    setupNearMobileWallet(),
    setupBitteWallet({ contractId }),
  ];
}
