import { EventEmitter } from 'events';
import { CentralOperation } from './types';
import { QPersistence } from './QPersistence';
// TODO: include uuid and documentId
// TODO: subscribe to client service

class CentralHandler extends EventEmitter {
  queue: QPersistence;
  localConflictId: string;
  uuid: string;
  conn: WebSocket | null;
  connAttempts: number;
  pingTimeout: number | undefined;
  reconnDelay: number;
  maxBackoff: number;

  constructor() {
    super();
    this.queue = new QPersistence();
    this.localConflictId = '';
    this.uuid = '';
    this.conn = null;
    this.connAttempts = 0;
    this.pingTimeout = undefined;
    this.reconnDelay = 0;
    this.maxBackoff = 64;
    this.connect();
  }

  get isOpen(): boolean {
    return this.conn?.readyState === this.conn?.OPEN;
  }

  get currLocalConflictId(): string {
    return this.localConflictId;
  }
  // heartbeat is necessary to inform the server that we're still connected.
  // exponential back-off is needed to make best effort to connect to the server.

  connect() {
    this.conn = new WebSocket('ws://localhost:8080');

    this.conn.addEventListener('open', this.onWebSocketOpen);

    this.conn.addEventListener('message', (event) => {
      const object = JSON.parse(event.data);
      this.handleIncomingOp(object).then((op) => {
        if (op) {
          this.parseResponse(op); // this has to return the change to customer's client. You can create eventhandlers for this.
        }
      });
    });

    this.conn.addEventListener('close', this.onWebSocketClose);
  }

  persistOutChange(opType: string, objectId: string): Error | undefined {
    const result = this.createConflictId(opType, objectId);
    if (typeof result === "string") {
      this.storeLocalConflictId(result);
    } else {
      return result;
    }
  }

  createConflictId(opType: string, objectId: string): string | Error {
    if (opType.length > 0 && objectId.length > 0) {
      return opType + "_" + objectId;
    }

    return new Error("inalid input");
  }

  onWebSocketOpen() {
    this.connAttempts = 0;
    console.log('Connected to Central service.');
  }

  onWebSocketClose() {
    this.conn = null;
    setTimeout(() => {
      this.reconnectToWebSocket();
    }, this.reconnDelay);
  }

  reconnectToWebSocket() {
    this.reconnDelay = Math.min((2 ^ this.connAttempts) + this.getRandomIntInclusive(1, 1000), this.maxBackoff);
    this.connect();
  }

  getRandomIntInclusive(min: number, max: number): number {
    const minimum = Math.ceil(min);
    const maximum = Math.floor(max);
    return Math.floor(Math.random() * (maximum - minimum + 1) + minimum);
  }

  parseResponse(op: CentralOperation.AckOperation) {
    const payload = op.payload;
    this.emit('message', payload);
  }

  storeLocalConflictId(conflictId: string): void {
    this.localConflictId = conflictId;
  }

  removeLocalConflictId(): void {
    this.localConflictId = '';
  }

  getUuid(): string {
    return this.uuid;
  }
  storeUuid(uuid: string): void {
    this.uuid = uuid;
  }

  removeUuid(): void {
    this.uuid = '';
  }

  send(data: Object) {
    if (!this.isOpen) return;
    this.conn?.send(JSON.stringify(data));
  }

  async handleIncomingOp(op: CentralOperation.AckOperation): Promise<CentralOperation.AckOperation | null> {
    const storedUuid = this.getUuid();
    console.log('stored uuid: ', storedUuid);
    if (storedUuid) {
      if (op.uuid === storedUuid) {
        console.log('Incoming packet treated as Inflight local');
        return await this.handleInflightOp(op).then((op) => op);
      } else {
        console.log('Incoming packet treated as remote');
        return await this.handleRemoteOp(op).then((op) => op);
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
      return await this.queue
        .enqueueOp(remoteOp)
        .then((response) => {
          return null;
        })
        .catch((err) => {
          throw new Error(err);
        });
    } else {
      return remoteOp;
    }
  }

  // Just as we receive back our own inflight op. Here, we perform resolver logic against our queue.
  async handleInflightOp(inflightOp: CentralOperation.AckOperation): Promise<CentralOperation.AckOperation> {
    return await this.queue.resolveInflightOp(inflightOp).then((op) => {
      this.removeLocalConflictId();
      return op;
    });
  }
}

export default CentralHandler;

/**
 * Define:
 * - the Operations: SET_X, CREATE_X, DELETE_X
 * - SET_X, where X is the attribute of the object being modified
 * - can we recognise the operations just by looking at the object?
 * - How do you accommodate adding new features, or 'object properties', into objects?
 * - do we merge them into the state without having to look into the individual fields? how granular do we want them to be?
 */
