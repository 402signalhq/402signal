import type {BatchRouteOptions} from '../../sdk/route-guard/batch.d.ts';
export interface NativeRequest {url:string;method:'GET'|'POST';body:Uint8Array;}
export interface NativeChallenge {status:402;wwwAuthenticate:string;bodyText?:string;paymentRequired?:string|null;}
export interface NativePolicy {network:'eip155:8453';asset:string;recipient:string;payer:string;maxAmountAtomic:string;realm?:string;maxAuthorizationSeconds?:number;}
export interface NativeInspection {readonly protocol:'mpp';readonly method:'evm';readonly intent:'charge';readonly network:'eip155:8453';readonly asset:string;readonly recipient:string;readonly payer:string;readonly amountAtomic:string;readonly expiresAt:number;readonly request:Readonly<{url:string;method:'GET'|'POST';bodyBase64:string}>;readonly challengeSha256:string;readonly responseSha256:string;readonly selectedChallengeSha256:string;readonly selectedChallengeId:string;}
export interface NativeTypedData {domain:{name:'USD Coin';version:'2';chainId:8453;verifyingContract:`0x${string}`};message:{from:`0x${string}`;to:`0x${string}`;value:bigint;validAfter:bigint;validBefore:bigint;nonce:`0x${string}`};primaryType:'TransferWithAuthorization';types:{TransferWithAuthorization:readonly {name:string;type:string}[]};}
export interface NativeSigner {address:string;signTypedData(data:NativeTypedData):Promise<`0x${string}`>;}
export interface NativeCredential {readonly authorizationId:string;readonly headerName:string;readonly headerValue:string;readonly request:NativeInspection['request'];readonly inspection:NativeInspection;}
export interface NativePrepared {readonly authorizationId:string;readonly inspection:NativeInspection;createCredential(options:{authorize:(claim:Readonly<{authorizationId:string;inspection:NativeInspection}>)=>Promise<NativeSigner>|NativeSigner}):Promise<NativeCredential>;}
export interface NativeOptions {request:NativeRequest;challenge:NativeChallenge;policy:NativePolicy;now?:()=>number;}
export function prepareNativeBaseMpp(options:NativeOptions):NativePrepared;
export function prepareVerifiedNativeBaseMpp(options:NativeOptions & {routeEvidence:Omit<BatchRouteOptions,'now'>}):NativePrepared;
