export interface AttemptStore {
  /** Private durable read; undefined means absent. Never log record contents. */
  get(id: string, part: string): Promise<unknown | undefined>;
  /** Atomic create-if-absent, durable before resolving. Never reclaim claims. */
  putOnce(id: string, part: string, value: unknown): Promise<boolean>;
}
export interface RouteResponse {status:number; bodyText:string; paymentResponse:string|null; retryAfter:string|null}
export interface RouteClassification {
  readonly settlementReport:'settled'|'not_attempted'|'unknown'|'unclassified';
  readonly normalMiss:boolean; readonly chainConfirmation:'not_checked';
  readonly newPaymentAllowed:false; readonly sellerExecutionAllowed:false;
}
export interface RouteResult {
  readonly id:string; readonly recoveryOnly:boolean; readonly reason:string; readonly retryAfter:string|null;
  readonly newPaymentAllowed:false; readonly sellerExecutionAllowed:false;
  readonly response?:Readonly<RouteResponse>; readonly classification?:RouteClassification;
}
export class RouteClientError extends Error {readonly code:string; readonly retryAfter?:string|null}
export function classifyRouteResponse(response:RouteResponse):RouteClassification;
export class RouteClient {
  constructor(options:{store:AttemptStore; routerUrl?:string;
    /** Operator confirms all serving revisions retain PR117's HTTP recovery contract. */
    recoveryProfile:'http-route-v1';
    /** Raw non-payment-aware fetch only, honoring AbortSignal, without retry middleware. */
    fetch?:typeof globalThis.fetch; timeoutMs?:number;
    /** Explicit loopback fixture use only. */
    allowInsecureLoopback?:boolean; now?:()=>number});
  prepare(id:string,requestJson:string):Promise<Readonly<{id:string;prepared:true}>>;
  challenge(id:string):Promise<Readonly<RouteResponse>>;
  /** Saves existing caller-owned authorization; never signs or releases buyer budget. */
  setPaymentHeader(id:string,header:{name?:'PAYMENT-SIGNATURE'|'PAYMENT-PAYLOAD'|'X-PAYMENT';value:string}):Promise<void>;
  submit(id:string):Promise<RouteResult>;
  recover(id:string):Promise<RouteResult>;
  evidence(id:string):Promise<ReadonlyArray<Readonly<{part:string;response:Readonly<RouteResponse>}>>>;
}
