"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
    result["default"] = mod;
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const Queue_1 = __importDefault(require("./Queue"));
const Base58 = __importStar(require("bs58"));
const MapSet_1 = __importDefault(require("./MapSet"));
const crypto = __importStar(require("hypercore/lib/crypto"));
const automerge_1 = require("automerge");
const DocFrontend_1 = require("./DocFrontend");
const Clock_1 = require("./Clock");
const debug_1 = __importDefault(require("debug"));
const Metadata_1 = require("./Metadata");
const mime_types_1 = __importDefault(require("mime-types"));
debug_1.default.formatters.b = Base58.encode;
const log = debug_1.default("repo:front");
let msgid = 1;
class RepoFrontend {
    constructor() {
        this.toBackend = new Queue_1.default("repo:tobackend");
        this.docs = new Map();
        this.cb = new Map();
        this.msgcb = new Map();
        this.readFiles = new MapSet_1.default();
        this.create = (init) => {
            const keys = crypto.keyPair();
            const publicKey = Base58.encode(keys.publicKey);
            const secretKey = Base58.encode(keys.secretKey);
            const docId = publicKey;
            const actorId = publicKey;
            const doc = new DocFrontend_1.DocFrontend(this, { actorId, docId });
            this.docs.set(docId, doc);
            this.toBackend.push({ type: "CreateMsg", publicKey, secretKey });
            if (init) {
                doc.change((state) => {
                    for (let key in init) {
                        state[key] = init[key];
                    }
                });
            }
            return `hypermerge:/${docId}`;
        };
        this.change = (id, fn) => {
            this.open(id).change(fn);
        };
        this.meta = (url, cb) => {
            const { id, type } = Metadata_1.validateURL(url);
            this.queryBackend({ type: "MetadataMsg", id }, (meta) => {
                if (meta) {
                    const doc = this.docs.get(id);
                    if (doc && meta.type === "Document") {
                        meta.actor = doc.actorId;
                        meta.history = doc.history;
                        meta.clock = doc.clock;
                    }
                }
                cb(meta);
            });
        };
        this.meta2 = (url) => {
            const { id, type } = Metadata_1.validateURL(url);
            const doc = this.docs.get(id);
            if (!doc)
                return;
            return {
                actor: doc.actorId,
                history: doc.history,
                clock: doc.clock
            };
        };
        this.merge = (url, target) => {
            const id = Metadata_1.validateDocURL(url);
            Metadata_1.validateDocURL(target);
            this.doc(target, (doc, clock) => {
                const actors = Clock_1.clock2strs(clock);
                this.toBackend.push({ type: "MergeMsg", id, actors });
            });
        };
        this.writeFile = (data, mimeType) => {
            const keys = crypto.keyPair();
            const publicKey = Base58.encode(keys.publicKey);
            const secretKey = Base58.encode(keys.secretKey);
            if (mime_types_1.default.extensions[mimeType] === undefined) {
                throw new Error(`invalid mime type ${mimeType}`);
            }
            this.toBackend.push(data);
            this.toBackend.push({ type: "WriteFile", publicKey, secretKey, mimeType });
            return `hyperfile:/${publicKey}`;
        };
        this.readFile = (url, cb) => {
            const id = Metadata_1.validateFileURL(url);
            this.readFiles.add(id, cb);
            this.toBackend.push({ type: "ReadFile", id });
        };
        this.fork = (url) => {
            Metadata_1.validateDocURL(url);
            const fork = this.create();
            this.merge(fork, url);
            return fork;
        };
        /*
          follow = (url: string, target: string) => {
            const id = validateDocURL(url);
            this.toBackend.push({ type: "FollowMsg", id, target });
          };
        */
        this.watch = (url, cb) => {
            Metadata_1.validateDocURL(url);
            const handle = this.open(url);
            handle.subscribe(cb);
            return handle;
        };
        this.doc = (url, cb) => {
            Metadata_1.validateDocURL(url);
            return new Promise(resolve => {
                const handle = this.open(url);
                handle.subscribe((val, clock) => {
                    resolve(val);
                    if (cb)
                        cb(val, clock);
                    handle.close();
                });
            });
        };
        this.materialize = (url, history, cb) => {
            const id = Metadata_1.validateDocURL(url);
            const doc = this.docs.get(id);
            if (doc === undefined) {
                throw new Error(`No such document ${id}`);
            }
            if (history < 0 && history >= doc.history) {
                throw new Error(`Invalid history ${history} for id ${id}`);
            }
            this.queryBackend({ type: "MaterializeMsg", history, id }, (patch) => {
                const doc = automerge_1.Frontend.init({ deferActorId: true });
                cb(automerge_1.Frontend.applyPatch(doc, patch));
            });
        };
        this.open = (url) => {
            const id = Metadata_1.validateDocURL(url);
            const doc = this.docs.get(id) || this.openDocFrontend(id);
            return doc.handle();
        };
        this.subscribe = (subscriber) => {
            this.toBackend.subscribe(subscriber);
        };
        this.close = () => {
            this.toBackend.push({ type: "CloseMsg" });
            this.docs.forEach(doc => doc.close());
            this.docs.clear();
        };
        this.destroy = (url) => {
            const { id } = Metadata_1.validateURL(url);
            this.toBackend.push({ type: "DestroyMsg", id });
            const doc = this.docs.get(id);
            if (doc) {
                // doc.destroy()
                this.docs.delete(id);
            }
        };
        /*
          handleReply = (id: number, reply: ToFrontendReplyMsg) => {
            const cb = this.cb.get(id)!
            switch (reply.type) {
              case "MaterializeReplyMsg": {
                cb(reply.patch);
                break;
              }
            }
            this.cb.delete(id)
          }
        */
        this.receive = (msg) => {
            if (msg instanceof Uint8Array) {
                this.file = msg;
            }
            else {
                switch (msg.type) {
                    case "ReadFileReply": {
                        const cbs = this.readFiles.delete(msg.id);
                        cbs.forEach(cb => cb(this.file, msg.mimeType));
                        delete this.file;
                        break;
                    }
                    case "PatchMsg": {
                        const doc = this.docs.get(msg.id);
                        if (doc) {
                            doc.patch(msg.patch, msg.synced, msg.history);
                        }
                        break;
                    }
                    case "Reply": {
                        const id = msg.id;
                        //          const reply = msg.reply
                        // this.handleReply(id,reply)
                        const cb = this.cb.get(id);
                        cb(msg.payload);
                        this.cb.delete(id);
                        break;
                    }
                    case "ActorIdMsg": {
                        const doc = this.docs.get(msg.id);
                        if (doc) {
                            doc.setActorId(msg.actorId);
                        }
                        break;
                    }
                    case "ReadyMsg": {
                        const doc = this.docs.get(msg.id);
                        if (doc) {
                            doc.init(msg.synced, msg.actorId, msg.patch, msg.history);
                        }
                        break;
                    }
                    case "ActorBlockDownloadedMsg": {
                        const doc = this.docs.get(msg.id);
                        if (doc) {
                            const progressEvent = {
                                actor: msg.actorId,
                                index: msg.index,
                                size: msg.size,
                                time: msg.time
                            };
                            doc.progress(progressEvent);
                        }
                        break;
                    }
                }
            }
        };
    }
    queryBackend(query, cb) {
        msgid += 1; // global counter
        const id = msgid;
        this.cb.set(id, cb);
        this.toBackend.push({ type: "Query", id, query });
    }
    debug(url) {
        const id = Metadata_1.validateDocURL(url);
        const doc = this.docs.get(id);
        const short = id.substr(0, 5);
        if (doc === undefined) {
            console.log(`doc:frontend undefined doc=${short}`);
        }
        else {
            console.log(`doc:frontend id=${short}`);
            console.log(`doc:frontend clock=${Clock_1.clockDebug(doc.clock)}`);
        }
        this.toBackend.push({ type: "DebugMsg", id });
    }
    openDocFrontend(id) {
        const doc = new DocFrontend_1.DocFrontend(this, { docId: id });
        this.toBackend.push({ type: "OpenMsg", id });
        this.docs.set(id, doc);
        return doc;
    }
}
exports.RepoFrontend = RepoFrontend;
//# sourceMappingURL=RepoFrontend.js.map