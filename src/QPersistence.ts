import { CentralOperation } from './types';

export enum TransactionMode {
  READ_ONLY = 'readonly',
  READ_WRITE = 'readwrite',
}

export class QPersistence {
  dbName: string;
  dbVersion: number;
  storeName: string;
  db: IDBDatabase | null;

  constructor() {
    this.dbName = 'ClientResolver';
    this.dbVersion = 1;
    this.storeName = 'queue_beta';
    this.db = null;
    this._initConnection();
  }

  _initConnection(): void {
    const dbOpenRequest = window.indexedDB.open(this.dbName, this.dbVersion);

    dbOpenRequest.onerror = (event) => {
      throw new Error(`Error opening database ${this.dbName}`);
    };

    // database successfully opened (existing)
    dbOpenRequest.onsuccess = (event) => {
      console.log(`Database ${this.dbName} version ${this.dbVersion} is opened.`);
      this.db = dbOpenRequest.result;
      // TODO: create object store and index
    };

    // database newly created
    dbOpenRequest.onupgradeneeded = (event) => {
      console.log(`Creating new database ${this.dbName} version ${this.dbVersion}.`);
      this.db = dbOpenRequest.result;
      this.createStore();
    };
  }

  // need to use this somewhere in the code
  createStore(): void {
    // let this be hardcoded for MVP.
    // TODO: create schema and make it more DI-like

    if (!this.db) {
      throw new Error(`Unable to create new ${this.storeName} object store.`);
    }

    this.db.createObjectStore(this.storeName, { autoIncrement: true });
  }

  _newTransaction(mode: TransactionMode): IDBTransaction {
    if (!this.db) {
      throw new Error(`Unable to create transaction for ${this.storeName} object store.`);
    }

    const transaction = this.db.transaction(this.storeName, mode);

    transaction.onerror = () => {
      throw new Error('Error in transaction');
    };

    return transaction;
  }

  // to be called by a logic that detects incoming remote op, retrieves it, and also retrieves any in-flight op in the local storage
  async enqueueOp(operation: CentralOperation.AckOperation): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const objectStore = this._newTransaction(TransactionMode.READ_WRITE).objectStore(this.storeName);

      const addRequest = objectStore.add(operation);

      addRequest.onsuccess = (event) => {
        resolve(true);
      };

      addRequest.onerror = (event) => {
        reject('Failed to add operation into the queue');
      };
    });
  }

  async _popOp(objectStore: IDBObjectStore, key: IDBValidKey): Promise<CentralOperation.AckOperation> {
    return new Promise<CentralOperation.AckOperation>((resolve, reject) => {
      const getRequest = objectStore.get(key);

      getRequest.onsuccess = (event) => {
        const object = getRequest.result;
        objectStore.delete(key);
        resolve(object);
      };

      getRequest.onerror = (event) => {
        reject('Unable to remove object with a given key and objectStore.');
      };
    });
  }

  // This is triggered assuming that the inflight op that arrived already has the same conflictId, which is the case following the system.
  // to be called by another logic that will retrieve inFlight local Op from the websocket
  //
  async resolveInflightOp(inflightOp: CentralOperation.AckOperation): Promise<CentralOperation.AckOperation> {
    return new Promise<CentralOperation.AckOperation>((resolve, reject) => {
      const objectStore = this._newTransaction(TransactionMode.READ_WRITE).objectStore(this.storeName);

      // peek
      const cursorRequest = objectStore.openCursor();

      cursorRequest.onsuccess = (event) => {
        const cursor = cursorRequest.result;
        let resolvedOp = inflightOp;

        if (cursor) {
          console.log(
            `Queue head with key ${cursor.key} has conflictId ${cursor.value.conflictId} and counter ${cursor.value.payload.newCounter}`,
          );
          if (inflightOp.mutationCounter > cursor.value.mutationCounter) {
            // get and remove, in the event that the local op counter is higher
            this._popOp(objectStore, cursor.key)
              .then((object) => {
                resolvedOp = inflightOp;
                cursor.continue();
              })
              .catch((err) => {
                reject(err);
              });
          } else if (inflightOp.mutationCounter < cursor.value.mutationCounter) {
            // get and remove, in the event that the remote op counter is higher
            this._popOp(objectStore, cursor.key)
              .then((object) => {
                resolvedOp = object;
                cursor.continue();
              })
              .catch((err) => {
                reject(err);
              });
          } else {
            throw new Error('Local and remote op has the same counter');
          }
        } else {
          resolve(resolvedOp);
        }
      };
    });
  }
}
