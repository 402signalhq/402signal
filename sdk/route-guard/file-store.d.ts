import type {AttemptStore} from './client.d.ts';
/** Private POSIX directory with immutable, fsynced records and exclusive claims.
 * Parent directory must exist. No encryption/key management or cleanup is supplied.
 * Native Windows requires a caller-provided equivalent store; WSL is supported.
 */
export class FileAttemptStore implements AttemptStore {
  constructor(directory:string);
  get(id:string,part:string):Promise<unknown|undefined>;
  putOnce(id:string,part:string,value:unknown):Promise<boolean>;
}
