export enum OperationType {
  Call, // 0
  DelegateCall, // 1
} 

export interface SafeTransaction {
  to: string;
  operation: OperationType
  data: string;
  value: string;
}