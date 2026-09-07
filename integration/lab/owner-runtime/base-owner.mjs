import { BaseBatchController } from "../dist/src/base-batch-lifecycle.js";
import { LocalBatchLedger, LocalOperationJournal } from "./local-ledger.mjs";
/** WSL caller supplies an existing signer and auth callback. No key loading,
 * background tasks, loop, automatic payment or error retry is implemented. */
export async function createLocalBaseCampaign({
  directory,
  campaignId,
  plan,
  rpc,
}) {
  const ledger = new LocalBatchLedger(directory, campaignId),
    journal = new LocalOperationJournal(ledger);
  const controller = new BaseBatchController(ledger, journal, rpc, plan);
  try {
    await controller.initialize();
    return { controller, ledger, close: () => ledger.close() };
  } catch (e) {
    ledger.close();
    throw e;
  }
}
