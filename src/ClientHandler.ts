import { EventEmitter } from 'events';
import { CentralOperation } from "./types";
import { QPersistence } from "./QPersistence";
// TODO: add networking to connect with Central service
class ClientHandler extends EventEmitter {
    queue               : QPersistence;
    localConflictId    : string;
    uuid               : string;
    conn               : WebSocket;
    isSubscribed        : boolean;

    constructor() {
        super();
        this.queue            = new QPersistence();
        this.localConflictId = "";
        this.uuid            = "";
        this.conn            = new WebSocket("ws://localhost:8080/ws"); 
        this.isSubscribed    = false;
        this.init();
    }

    async init() {
        this.conn.addEventListener('open',
            event => {
                console.log('Connected to Central service.')
                this.isSubscribed = true;
            }
        );

        this.conn.addEventListener('message',
            event => {
                const object = JSON.parse(event.data);
                this.handleIncomingOp(object)
                    .then((op) => {
                        if (op) {
                            this.parseResponse(op); //this has to return the change to customer's client. You can create eventhandlers for this.
                        }
                    });
            }
        ) 
    }

    get isOpen(): boolean { return this.isSubscribed; }

    get currLocalConflictId(): string { return this.localConflictId; }

    parseResponse(op: CentralOperation.AckOperation) {
        const payload = op.payload;
        this.emit('message', payload);
    }

    storeLocalConflictId(conflictId: string): void {
        this.localConflictId = conflictId;
    }

    removeLocalConflictId(): void {
        this.localConflictId = "";
    }

    getUuid(): string {
        return this.uuid;
    
    }
    storeUuid(uuid: string): void {
        this.uuid = uuid;
    }

    removeUuid(): void {
        this.uuid = "";
    }

    async handleIncomingOp(op: CentralOperation.AckOperation): Promise<CentralOperation.AckOperation | null> {
        const storedUuid = this.getUuid();
        console.log("stored uuid: ", storedUuid);
        if (storedUuid) {
            if (op.uuid === storedUuid) {
                console.log("Incoming packet treated as Inflight local");
                return await this.handleInflightOp(op)
                    .then((op) => op);

            } else {
                console.log("Incoming packet treated as remote");
                return await this.handleRemoteOp(op)
                    .then((op) => op);
            }

        } else {
            this.storeUuid(op.uuid);
            return op;
        }
    }

    // Just as we receive new remote op. Here, we perform conflictId lookup
    async handleRemoteOp(remoteOp: CentralOperation.AckOperation): Promise<CentralOperation.AckOperation | null> {
        const inflightId = this.currLocalConflictId;
        
        if (inflightId === null) {
            return remoteOp;

        } else if (inflightId === remoteOp.conflictId) {
            return await this.queue.enqueueOp(remoteOp).then((response) => {
                return null;

            }).catch((err) => {
                throw new Error(err);
            });

        } else {
            return remoteOp;
        }
    };

    // Just as we receive back our own inflight op. Here, we perform resolver logic against our queue.
    async handleInflightOp(inflightOp: CentralOperation.AckOperation): Promise<CentralOperation.AckOperation> {
        return await this.queue.resolveInflightOp(inflightOp).then((op) => {
            this.removeLocalConflictId();
            return op;
        })
    }
}

export default ClientHandler;

/**
 * Define:
 * - the Operations: SET_X, CREATE_X, DELETE_X
 * - SET_X, where X is the attribute of the object being modified
 * - can we recognise the operations just by looking at the object?
 * - How do you accommodate adding new features, or 'object properties', into objects?
 * - do we merge them into the state without having to look into the individual fields? how granular do we want them to be?
 */