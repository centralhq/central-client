export namespace CentralOperation {
  export type AckOperation = {
    status: string;
    operationType: string;
    uuid: string;
    objectId: string;
    mutationCounter: number;
    conflictId: string;
    payload: Object;
  };
}
