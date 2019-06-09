"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
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
const Metadata_1 = require("./Metadata");
const Actor_1 = require("./Actor");
const Clock_1 = require("./Clock");
const Base58 = __importStar(require("bs58"));
const crypto = __importStar(require("hypercore/lib/crypto"));
const hypercore_1 = require("./hypercore");
const automerge_1 = require("automerge");
const DocBackend_1 = require("./DocBackend");
const Misc_1 = require("./Misc");
const debug_1 = __importDefault(require("debug"));
const DocumentBroadcast = __importStar(require("./DocumentBroadcast"));
const Keys = __importStar(require("./Keys"));
debug_1.default.formatters.b = Base58.encode;
const HypercoreProtocol = require("hypercore-protocol");
const log = debug_1.default("repo:backend");
class RepoBackend {
    constructor(opts) {
        this.joined = new Set();
        this.actors = new Map();
        this.actorsDk = new Map();
        this.docs = new Map();
        this.toFrontend = new Queue_1.default("repo:toFrontend");
        /*
          follow(id: string, target: string) {
            this.meta.follow(id, target);
            this.syncReadyActors(this.meta.actors(id));
          }
        */
        this.close = () => {
            this.actors.forEach(actor => actor.close());
            this.actors.clear();
            const swarm = this.swarm; // FIXME - any is bad
            if (swarm) {
                try {
                    swarm.discovery.removeAllListeners();
                    swarm.discovery.close();
                    swarm.peers.forEach((p) => p.connections.forEach((con) => con.destroy()));
                    swarm.removeAllListeners();
                }
                catch (error) { }
            }
        };
        this.replicate = (swarm) => {
            if (this.swarm) {
                throw new Error("replicate called while already swarming");
            }
            this.swarm = swarm;
            for (let dk of this.joined) {
                log("swarm.join");
                this.swarm.join(Base58.decode(dk));
            }
        };
        this.join = (actorId) => {
            const dkBuffer = hypercore_1.discoveryKey(Base58.decode(actorId));
            const dk = Base58.encode(dkBuffer);
            if (this.swarm && !this.joined.has(dk)) {
                log("swarm.join", Misc_1.ID(actorId), Misc_1.ID(dk));
                this.swarm.join(dkBuffer);
            }
            this.joined.add(dk);
        };
        this.leave = (actorId) => {
            const dkBuffer = hypercore_1.discoveryKey(Base58.decode(actorId));
            const dk = Base58.encode(dkBuffer);
            if (this.swarm && this.joined.has(dk)) {
                log("leave", Misc_1.ID(actorId), Misc_1.ID(dk));
                this.swarm.leave(dkBuffer);
            }
            this.joined.delete(dk);
        };
        this.getReadyActor = (actorId) => {
            const publicKey = Base58.decode(actorId);
            const actor = this.actors.get(actorId) || this.initActor({ publicKey });
            const actorPromise = new Promise((resolve, reject) => {
                try {
                    actor.onReady(resolve);
                }
                catch (e) {
                    reject(e);
                }
            });
            return actorPromise;
        };
        this.storageFn = (path) => {
            return (name) => {
                return this.storage(this.path + "/" + path + "/" + name);
            };
        };
        this.syncReadyActors = (ids) => {
            ids.forEach((id) => __awaiter(this, void 0, void 0, function* () {
                const actor = yield this.getReadyActor(id);
                this.syncChanges(actor);
            }));
        };
        this.documentNotify = (msg) => {
            switch (msg.type) {
                case "ReadyMsg": {
                    this.toFrontend.push({
                        type: "ReadyMsg",
                        id: msg.id,
                        synced: msg.synced,
                        actorId: msg.actorId,
                        history: msg.history,
                        patch: msg.patch
                    });
                    break;
                }
                case "ActorIdMsg": {
                    this.toFrontend.push({
                        type: "ActorIdMsg",
                        id: msg.id,
                        actorId: msg.actorId
                    });
                    break;
                }
                case "RemotePatchMsg": {
                    this.toFrontend.push({
                        type: "PatchMsg",
                        id: msg.id,
                        synced: msg.synced,
                        patch: msg.patch,
                        history: msg.history
                    });
                    break;
                }
                case "LocalPatchMsg": {
                    this.toFrontend.push({
                        type: "PatchMsg",
                        id: msg.id,
                        synced: msg.synced,
                        patch: msg.patch,
                        history: msg.history
                    });
                    this.actor(msg.actorId).writeChange(msg.change);
                    break;
                }
                default: {
                    console.log("Unknown message type", msg);
                }
            }
        };
        this.broadcastNotify = (msg) => {
            switch (msg.type) {
                case "RemoteMetadata": {
                    for (let id in msg.clocks) {
                        const clock = msg.clocks[id];
                        const doc = this.docs.get(id);
                        if (clock && doc) {
                            doc.target(clock);
                        }
                    }
                    const _blocks = msg.blocks;
                    this.meta.addBlocks(_blocks);
                    _blocks.map(block => {
                        if (block.actors)
                            this.syncReadyActors(block.actors);
                        if (block.merge)
                            this.syncReadyActors(Object.keys(block.merge));
                        // if (block.follows) block.follows.forEach(id => this.open(id))
                    });
                    break;
                }
                case "NewMetadata": {
                    // TODO: Warn better than this!
                    console.log("Legacy Metadata message received - better upgrade");
                    break;
                }
            }
        };
        this.actorNotify = (msg) => {
            switch (msg.type) {
                case "ActorFeedReady": {
                    const actor = msg.actor;
                    // Record whether or not this actor is writable.
                    this.meta.setWritable(actor.id, msg.writable);
                    // Broadcast latest document information to peers.
                    const metadata = this.meta.forActor(actor.id);
                    const clocks = this.allClocks(actor.id);
                    this.meta.docsWith(actor.id).forEach(documentId => {
                        const documentActor = this.actor(documentId);
                        if (documentActor) {
                            DocumentBroadcast.broadcast(metadata, clocks, documentActor.peers);
                        }
                    });
                    this.join(actor.id);
                    break;
                }
                case "ActorInitialized": {
                    // Swarm on the actor's feed.
                    this.join(msg.actor.id);
                    break;
                }
                case "PeerAdd": {
                    // Listen for hypermerge extension broadcasts.
                    DocumentBroadcast.listen(msg.peer, this.broadcastNotify);
                    // Broadcast the latest document information to the new peer
                    const metadata = this.meta.forActor(msg.actor.id);
                    const clocks = this.allClocks(msg.actor.id);
                    DocumentBroadcast.broadcast(metadata, clocks, [msg.peer]);
                    break;
                }
                case "ActorSync":
                    log("ActorSync", msg.actor.id);
                    this.syncChanges(msg.actor);
                    break;
                case "Download":
                    this.meta.docsWith(msg.actor.id).forEach((doc) => {
                        this.toFrontend.push({
                            type: "ActorBlockDownloadedMsg",
                            id: doc,
                            actorId: msg.actor.id,
                            index: msg.index,
                            size: msg.size,
                            time: msg.time
                        });
                    });
                    break;
            }
        };
        this.syncChanges = (actor) => {
            const actorId = actor.id;
            const docIds = this.meta.docsWith(actorId);
            docIds.forEach(docId => {
                const doc = this.docs.get(docId);
                if (doc) {
                    doc.ready.push(() => {
                        const max = this.meta.clockAt(docId, actorId);
                        const min = doc.changes.get(actorId) || 0;
                        const changes = [];
                        let i = min;
                        for (; i < max && actor.changes.hasOwnProperty(i); i++) {
                            const change = actor.changes[i];
                            log(`change found xxx id=${Misc_1.ID(actor.id)} seq=${change.seq}`);
                            changes.push(change);
                        }
                        doc.changes.set(actorId, i);
                        //        log(`changes found xxx doc=${ID(docId)} actor=${ID(actor.id)} n=[${min}+${changes.length}/${max}]`);
                        if (changes.length > 0) {
                            log(`applyremotechanges ${changes.length}`);
                            doc.applyRemoteChanges(changes);
                        }
                    });
                }
            });
        };
        this.stream = (opts) => {
            const stream = HypercoreProtocol({
                live: true,
                id: this.id,
                encrypt: false,
                timeout: 10000,
                extensions: DocumentBroadcast.SUPPORTED_EXTENSIONS
            });
            let add = (dk) => {
                const actor = this.actorsDk.get(Base58.encode(dk));
                if (actor) {
                    log("replicate feed!", Misc_1.ID(Base58.encode(dk)));
                    actor.feed.replicate({
                        stream,
                        live: true
                    });
                }
            };
            stream.on("feed", (dk) => add(dk));
            const dk = opts.channel || opts.discoveryKey;
            if (dk)
                add(dk);
            return stream;
        };
        this.subscribe = (subscriber) => {
            this.toFrontend.subscribe(subscriber);
        };
        this.handleQuery = (id, query) => {
            switch (query.type) {
                case "MetadataMsg": {
                    this.meta.publicMetadata(query.id, (payload) => {
                        this.toFrontend.push({ type: "Reply", id, payload });
                    });
                    break;
                }
                case "MaterializeMsg": {
                    const doc = this.docs.get(query.id);
                    const changes = doc.back.getIn(['opSet', 'history']).slice(0, query.history).toArray();
                    const [_, patch] = automerge_1.Backend.applyChanges(automerge_1.Backend.init(), changes);
                    this.toFrontend.push({ type: "Reply", id, payload: patch });
                    break;
                }
            }
        };
        this.receive = (msg) => {
            if (msg instanceof Uint8Array) {
                this.file = msg;
            }
            else {
                switch (msg.type) {
                    case "NeedsActorIdMsg": {
                        const doc = this.docs.get(msg.id);
                        const actorId = this.initActorFeed(doc);
                        doc.initActor(actorId);
                        break;
                    }
                    case "RequestMsg": {
                        const doc = this.docs.get(msg.id);
                        doc.applyLocalChange(msg.request);
                        break;
                    }
                    case "WriteFile": {
                        const keys = {
                            publicKey: Keys.decode(msg.publicKey),
                            secretKey: Keys.decode(msg.secretKey)
                        };
                        log("write file", msg.mimeType);
                        this.writeFile(keys, this.file, msg.mimeType);
                        delete this.file;
                        break;
                    }
                    case "Query": {
                        const query = msg.query;
                        const id = msg.id;
                        this.handleQuery(id, query);
                        break;
                    }
                    case "ReadFile": {
                        const id = msg.id;
                        log("read file", id);
                        this.readFile(id).then(file => {
                            this.toFrontend.push(file.body);
                            this.toFrontend.push({ type: "ReadFileReply", id, mimeType: file.mimeType });
                        });
                        break;
                    }
                    case "CreateMsg": {
                        const keys = {
                            publicKey: Keys.decode(msg.publicKey),
                            secretKey: Keys.decode(msg.secretKey)
                        };
                        this.create(keys);
                        break;
                    }
                    case "MergeMsg": {
                        this.merge(msg.id, Clock_1.strs2clock(msg.actors));
                        break;
                    }
                    /*
                            case "FollowMsg": {
                              this.follow(msg.id, msg.target);
                              break;
                            }
                    */
                    case "OpenMsg": {
                        this.open(msg.id);
                        break;
                    }
                    case "DestroyMsg": {
                        this.destroy(msg.id);
                        break;
                    }
                    case "DebugMsg": {
                        this.debug(msg.id);
                        break;
                    }
                    case "CloseMsg": {
                        this.close();
                        break;
                    }
                }
            }
        };
        this.opts = opts;
        this.path = opts.path || "default";
        this.storage = opts.storage;
        this.meta = new Metadata_1.Metadata(this.storageFn, this.join, this.leave);
        this.id = this.meta.id;
    }
    writeFile(keys, data, mimeType) {
        const fileId = Keys.encode(keys.publicKey);
        this.meta.addFile(fileId, data.length, mimeType);
        const actor = this.initActor(keys);
        actor.writeFile(data, mimeType);
    }
    readFile(id) {
        return __awaiter(this, void 0, void 0, function* () {
            //    log("readFile",id, this.meta.forDoc(id))
            if (this.meta.isDoc(id)) {
                throw new Error("trying to open a document like a file");
            }
            const actor = yield this.getReadyActor(id);
            return actor.readFile();
        });
    }
    create(keys) {
        const docId = Keys.encode(keys.publicKey);
        log("create", docId);
        const doc = new DocBackend_1.DocBackend(docId, this.documentNotify, automerge_1.Backend.init());
        this.docs.set(docId, doc);
        this.meta.addActor(doc.id, doc.id);
        this.initActor(keys);
        return doc;
    }
    debug(id) {
        const doc = this.docs.get(id);
        const short = id.substr(0, 5);
        if (doc === undefined) {
            console.log(`doc:backend NOT FOUND id=${short}`);
        }
        else {
            console.log(`doc:backend id=${short}`);
            console.log(`doc:backend clock=${Clock_1.clockDebug(doc.clock)}`);
            const local = this.meta.localActorId(id);
            const actors = this.meta.actors(id);
            const info = actors
                .map(actor => {
                const nm = actor.substr(0, 5);
                return local === actor ? `*${nm}` : nm;
            })
                .sort();
            console.log(`doc:backend actors=${info.join(",")}`);
        }
    }
    destroy(id) {
        this.meta.delete(id);
        const doc = this.docs.get(id);
        if (doc) {
            this.docs.delete(id);
        }
        const actors = this.meta.allActors();
        this.actors.forEach((actor, id) => {
            if (!actors.has(id)) {
                console.log("Orphaned actors - will purge", id);
                this.actors.delete(id);
                this.leave(actor.id);
                actor.destroy();
            }
        });
    }
    // opening a file fucks it up
    open(docId) {
        //    log("open", docId, this.meta.forDoc(docId));
        if (this.meta.isFile(docId)) {
            throw new Error("trying to open a file like a document");
        }
        let doc = this.docs.get(docId) || new DocBackend_1.DocBackend(docId, this.documentNotify);
        if (!this.docs.has(docId)) {
            this.docs.set(docId, doc);
            this.meta.addActor(docId, docId);
            this.loadDocument(doc);
        }
        return doc;
    }
    merge(id, clock) {
        this.meta.merge(id, clock);
        this.syncReadyActors(Object.keys(clock));
    }
    allReadyActors(docId) {
        return __awaiter(this, void 0, void 0, function* () {
            const actorIds = yield this.meta.actorsAsync(docId);
            return Promise.all(actorIds.map(this.getReadyActor));
        });
    }
    loadDocument(doc) {
        return __awaiter(this, void 0, void 0, function* () {
            const actors = yield this.allReadyActors(doc.id);
            log(`load document 2 actors=${actors.map((a) => a.id)}`);
            const changes = [];
            actors.forEach(actor => {
                const max = this.meta.clockAt(doc.id, actor.id);
                const slice = actor.changes.slice(0, max);
                doc.changes.set(actor.id, slice.length);
                log(`change actor=${Misc_1.ID(actor.id)} changes=0..${slice.length}`);
                changes.push(...slice);
            });
            log(`loading doc=${Misc_1.ID(doc.id)} changes=${changes.length}`);
            // Check to see if we already have a local actor id. If so, re-use it.
            const localActorId = this.meta.localActorId(doc.id);
            const actorId = localActorId ? (yield this.getReadyActor(localActorId)).id : this.initActorFeed(doc);
            doc.init(changes, actorId);
        });
    }
    initActorFeed(doc) {
        log("initActorFeed", doc.id);
        const keys = crypto.keyPair();
        const actorId = Keys.encode(keys.publicKey);
        this.meta.addActor(doc.id, actorId);
        this.initActor(keys);
        return actorId;
    }
    actorIds(doc) {
        return this.meta.actors(doc.id);
    }
    docActors(doc) {
        return this.actorIds(doc)
            .map(id => this.actors.get(id))
            .filter(Misc_1.notEmpty);
    }
    allClocks(actorId) {
        const clocks = {};
        this.meta.docsWith(actorId).forEach(documentId => {
            const doc = this.docs.get(documentId);
            if (doc) {
                clocks[documentId] = doc.clock;
            }
        });
        return clocks;
    }
    initActor(keys) {
        const notify = this.actorNotify;
        const storage = this.storageFn;
        const actor = new Actor_1.Actor({ keys, notify, storage });
        this.actors.set(actor.id, actor);
        this.actorsDk.set(actor.dkString, actor);
        return actor;
    }
    actor(id) {
        return this.actors.get(id);
    }
}
exports.RepoBackend = RepoBackend;
//# sourceMappingURL=RepoBackend.js.map