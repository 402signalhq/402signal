/** A trusted offline verification boundary. No live wallet or network transport. */
import { withVerifiedRoute } from '../../sdk/route-guard/index.mjs';

export async function authorize(options, fakeCallback) {
  return withVerifiedRoute(options, fakeCallback);
}
