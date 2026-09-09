# Try your buyer adapter

This pilot tests an integration boundary before using a funded wallet. It does not require registration, telemetry or production credentials. A reference fixture pass is not a production integration or a live merchant qualification.

## Three useful participants

Invite an agent operator, a payment SDK/MCP maintainer and an agent-platform policy owner. Each team should use its own adapter and separately retained spending rules. Participation is voluntary. Do not send production wallet material, payment headers, private receipts or customer payloads.

From a reviewed checkout with Node.js 22 or newer, run:

```sh
node integration/buyer-checks/run.mjs
node integration/buyer-checks/run.mjs --adapter ./integration/buyer-checks/example-adapter.mjs
node integration/buyer-checks/run.mjs --self-test
```

Expected normal summary: buyer adapter 5/5, historical verifier 2/2, failed 0. Copy the example adapter and connect your trusted verification boundary; running the supplied example alone does not test your application. Run custom code without production credentials and with external networking blocked. The worker timeout is not a sandbox.

The version 2 report gives scenario IDs, the tested subject, fixture hash, measured callback counts, expected refusal codes and debugging actions. Generic exceptions are errors, not valid refusals. The historical verifier uses the reference implementation independently of your adapter.

## Tasks for the pilot

| Task | Evidence to retain | What this stage establishes |
|---|---|---|
| Change the seller recipient | Refusal and zero fake authorization calls | Exact Base fixture boundary only |
| Keep the original offer | One fake authorization with matching terms | Positive control |
| Alter the saved policy | Historical verification refusal | Covered-record integrity, not human approval |
| Investigate a lost response | Existing journal and read-only recovery plan | Use the separate recovery guide; this pack does not exercise recovery |
| Choose among MPP offers | Explicit match, ambiguity or no-match result | Use the separate MPP tests; not covered by this pack |
| Call an ordinary free weather API | Direct free request | No paid 402Signal check is needed |
| Inspect an unsupported merchant profile | Supported/unsupported distinction | Unsupported does not mean broken or unsafe |

Use [routing-attempt recovery](route-recovery.md) for a lost 402Signal response. Seller-payment reconciliation belongs to the selected buyer client: payment confirmation does not establish useful output or recover an arbitrary missing response. Do not authorize a new payment merely to escape an unknown outcome.

## Record useful outcomes

Record the reviewed code revision, Node version, adapter/dependency version, task, elapsed time, tool calls, valid arguments, false refusals and what the check caught or simplified. For agent evaluations also record host/model version, available tools, initial context and whether the skill was already installed. Separate deterministic tests from actual agent runs, and synthetic/operator tests from external adoption.

Do not collect wallet addresses or raw requests as customer identifiers. Downloads and user-agent strings are not unique users. Share only a reviewed, opt-in diagnostic report; the runner sends nothing automatically.

Ask participants whether they retained local verification, integrated the hosted observation, or only reused the fixtures. A later hosted pilot requires its own explicit payment path and budget. The target is a useful returning integration, not more requests or a promised conversion rate.

## Invitation draft

We are testing whether 402Signal's offline checks catch useful integration mistakes before an agent uses a funded wallet. Would you try the free pack with your own buyer adapter and tell us what it caught or made clearer? No production credentials or payment are needed. We are especially interested in false refusals and places where the instructions require guesswork. Please share only sanitized results you choose to disclose.

This is a draft for owner-approved outreach. No invitations or upstream submissions have been sent by adding this document.

## Upstream contribution candidate

Offer a small optional recipient-change/expiry regression fixture to a payment-client maintainer after confirming its callback contract. Keep their positive acceptance case and measure callback counts in the harness. Submit reproducible tests and limitations, not promotional comments. No upstream compatibility or acceptance is claimed yet.
