/** Private POSIX filesystem adapter. Immutable records and unreclaimed claims. */
import {constants as C,promises as fs} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {parse} from './internal-json.mjs';
import {RouteClientError,validStorePart} from './client.mjs';
const MAX=1048576;
function check(ok) {if(!ok)throw new RouteClientError('private_store_unavailable');}
export class FileAttemptStore {
  #directory;
  constructor(directory) {check(typeof directory==='string'&&directory.length>0&&process.platform!=='win32');this.#directory=resolve(directory);}
  async #root() {
    try {await fs.mkdir(this.#directory,{mode:0o700});} catch(e) {if(e.code!=='EEXIST')throw e;}
    const s=await fs.lstat(this.#directory);check(s.isDirectory()&&!s.isSymbolicLink()&&(s.mode&0o077)===0&&s.uid===process.getuid());
    // Persist the root directory entry before any attempt may become payable.
    const parent=await fs.open(dirname(this.#directory),C.O_RDONLY|C.O_DIRECTORY);
    try {await parent.sync();} finally {await parent.close();}
  }
  #path(id,part) {check(typeof id==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(id)&&validStorePart(part));return join(this.#directory,id+'.'+part+'.json');}
  async get(id,part) {
    await this.#root();let h;
    try {h=await fs.open(this.#path(id,part),C.O_RDONLY|C.O_NOFOLLOW);}
    catch(e){if(e.code==='ENOENT')return undefined;throw new RouteClientError('private_store_unavailable');}
    try {const s=await h.stat();check(s.isFile()&&s.size<=MAX&&(s.mode&0o077)===0&&s.uid===process.getuid());return parse(await h.readFile('utf8'),{ordinaryNumbers:true,limit:MAX});}
    finally {await h.close();}
  }
  async putOnce(id,part,value) {
    await this.#root();const raw=JSON.stringify(value);check(typeof raw==='string'&&Buffer.byteLength(raw)<=MAX);let h;
    try {h=await fs.open(this.#path(id,part),C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o600);}
    catch(e){if(e.code==='EEXIST')return false;throw new RouteClientError('private_store_unavailable');}
    try {await h.writeFile(raw);await h.sync();} finally {await h.close();}
    const dir=await fs.open(this.#directory,C.O_RDONLY|C.O_DIRECTORY);
    try {await dir.sync();} finally {await dir.close();}
    // Never remove a partially written claim after an error: fail closed instead.
    return true;
  }
}
