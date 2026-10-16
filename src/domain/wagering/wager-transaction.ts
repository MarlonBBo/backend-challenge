import { LedgerDirection } from '../ledger/ledger-direction';
import type { Money } from '../shared/value-objects/money';
import { FailureCode } from './failure-code';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export interface CreateWagerTransactionProps {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string;
  readonly createdAt: Date;
}

export interface CreateOpeningTransactionProps {
  readonly id: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly money: Money;
  readonly createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  readonly status: WagerTransactionStatus;
  readonly referenceTransactionId?: string;
  readonly failureCode?: FailureCode;
  readonly resultBalance?: Money;
  readonly referenceAttempts?: number;
  readonly nextReferenceAttemptAt?: Date;
  readonly processedAt?: Date;
}

export class InvalidWagerTransactionError extends Error {
  readonly code = 'INVALID_WAGER_TRANSACTION';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidWagerTransactionError';
  }
}

export class InvalidTransactionStateError extends Error {
  readonly code = 'INVALID_TRANSACTION_STATE';

  constructor(status: WagerTransactionStatus) {
    super(`A transaction in terminal status ${status} cannot transition`);
    this.name = 'InvalidTransactionStateError';
  }
}

export class InvalidWagerReferenceError extends Error {
  constructor(
    public readonly failureCode: FailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'InvalidWagerReferenceError';
  }
}

export class LedgerDirectionNotApplicableError extends Error {
  readonly code = 'LEDGER_DIRECTION_NOT_APPLICABLE';

  constructor(kind: WagerTransactionKind) {
    super(`Transaction kind ${kind} does not produce a ledger entry`);
    this.name = 'LedgerDirectionNotApplicableError';
  }
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    private readonly _createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _resultBalance?: Money,
    private _referenceAttempts = 0,
    private _nextReferenceAttemptAt?: Date,
    private _processedAt?: Date,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError(
        'OPENING cannot be submitted as an external transaction',
      );
    }

    WagerTransaction.assertCreationRules(props);
    return WagerTransaction.build({ ...props, status: WagerTransactionStatus.Pending });
  }

  static createOpening(props: CreateOpeningTransactionProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError('OPENING amount must be positive');
    }

    WagerTransaction.assertValidTimestamp(props.createdAt);

    return WagerTransaction.build({
      id: props.id,
      providerId: 'system',
      externalTransactionId: `wallet-opening:${props.walletId}`,
      idempotencyKey: `wallet-opening:${props.walletId}`,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: 'wallet-opening',
      gameId: 'system',
      kind: WagerTransactionKind.Opening,
      money: props.money,
      createdAt: props.createdAt,
      status: WagerTransactionStatus.Pending,
    });
  }

  /** Reconstrói o estado persistido confiável sem reexecutar as regras de transição. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return WagerTransaction.build(state);
  }

  get createdAt(): Date {
    return new Date(this._createdAt);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt === undefined ? undefined : new Date(this._processedAt);
  }

  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt === undefined
      ? undefined
      : new Date(this._nextReferenceAttemptAt);
  }

  markProcessed(reference: WagerTransaction | undefined, at: Date, resultBalance?: Money): void {
    this.assertNotTerminal();
    WagerTransaction.assertValidTimestamp(at);
    this.assertReferenceForProcessing(reference);
    this.assertResultBalance(resultBalance);

    this._referenceTransactionId = reference?.id;
    this._status = WagerTransactionStatus.Processed;
    this._resultBalance = resultBalance;
    this._nextReferenceAttemptAt = undefined;
    this._processedAt = new Date(at);
  }

  markPendingReference(resultBalance?: Money, nextAttemptAt?: Date): void {
    this.assertNotTerminal();

    if (this.referenceExternalTransactionId === undefined) {
      throw new InvalidWagerTransactionError(
        'Only a transaction with an external reference can wait for a reference',
      );
    }

    this.assertResultBalance(resultBalance);
    if (nextAttemptAt !== undefined) {
      WagerTransaction.assertValidTimestamp(nextAttemptAt);
    }

    this._status = WagerTransactionStatus.PendingReference;
    this._resultBalance = resultBalance;
    this._nextReferenceAttemptAt =
      nextAttemptAt === undefined ? undefined : new Date(nextAttemptAt);
  }

  reject(code: FailureCode, at: Date, resultBalance?: Money, reference?: WagerTransaction): void {
    this.assertNotTerminal();
    WagerTransaction.assertValidTimestamp(at);
    this.assertResultBalance(resultBalance);
    this._referenceTransactionId = reference?.id;
    this._resultBalance = resultBalance;
    this._nextReferenceAttemptAt = undefined;
    this.moveToFailedState(WagerTransactionStatus.Rejected, code, at);
  }

  recordReferenceAttempt(): void {
    this.assertNotTerminal();
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidWagerTransactionError('Only pending references can be retried');
    }
    this._referenceAttempts += 1;
  }

  fail(code: FailureCode, at: Date): void {
    this.moveToFailedState(WagerTransactionStatus.Failed, code, at);
  }

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
        if (this.kind === WagerTransactionKind.Win) {
          this.assertReferenceForProcessing(reference);
        }
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Refund:
        this.assertReferenceForProcessing(reference);
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        this.assertReferenceForProcessing(reference);
        const referencedDirection =
          reference?.kind === WagerTransactionKind.Bet
            ? LedgerDirection.Debit
            : LedgerDirection.Credit;

        return referencedDirection === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new LedgerDirectionNotApplicableError(this.kind);
    }
  }

  private static build(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      new Date(state.createdAt),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.resultBalance,
      state.referenceAttempts ?? 0,
      state.nextReferenceAttemptAt === undefined
        ? undefined
        : new Date(state.nextReferenceAttemptAt),
      state.processedAt === undefined ? undefined : new Date(state.processedAt),
    );
  }

  private static assertCreationRules(props: CreateWagerTransactionProps): void {
    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError('Transaction amount must be positive');
    }

    WagerTransaction.assertValidTimestamp(props.createdAt);

    if (props.referenceExternalTransactionId !== undefined) {
      if (
        props.referenceExternalTransactionId.length === 0 ||
        props.referenceExternalTransactionId.trim() !== props.referenceExternalTransactionId
      ) {
        throw new InvalidWagerTransactionError(
          'External reference must be a non-empty canonical string',
        );
      }
    }

    const hasReference =
      props.referenceExternalTransactionId !== undefined &&
      props.referenceExternalTransactionId.length > 0;

    if (
      (props.kind === WagerTransactionKind.Refund ||
        props.kind === WagerTransactionKind.Rollback) &&
      !hasReference
    ) {
      throw new InvalidWagerTransactionError(`${props.kind} requires an external reference`);
    }

    if (
      (props.kind === WagerTransactionKind.Bet || props.kind === WagerTransactionKind.Loss) &&
      hasReference
    ) {
      throw new InvalidWagerTransactionError(`${props.kind} cannot have an external reference`);
    }
  }

  private static assertValidTimestamp(timestamp: Date): void {
    if (Number.isNaN(timestamp.getTime())) {
      throw new InvalidWagerTransactionError('Transaction timestamp must be a valid date');
    }
  }

  private assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this._status);
    }
  }

  private assertResultBalance(resultBalance: Money | undefined): void {
    if (resultBalance === undefined) {
      return;
    }

    if (resultBalance.currency !== this.money.currency || resultBalance.isNegative()) {
      throw new InvalidWagerTransactionError(
        'Result balance must be non-negative and use the transaction currency',
      );
    }
  }

  private assertReferenceForProcessing(reference?: WagerTransaction): void {
    const expectsReference = this.referenceExternalTransactionId !== undefined;

    if (!expectsReference && reference !== undefined) {
      throw new InvalidWagerTransactionError('Transaction does not declare an external reference');
    }

    if (!expectsReference) {
      return;
    }

    if (reference === undefined) {
      throw new InvalidWagerReferenceError(
        FailureCode.ReferenceNotFound,
        'The referenced transaction was not provided',
      );
    }

    if (reference.externalTransactionId !== this.referenceExternalTransactionId) {
      throw new InvalidWagerReferenceError(
        FailureCode.ReferenceContextMismatch,
        'The resolved transaction does not match the external reference',
      );
    }

    if (!reference.isTerminal() || reference.status !== WagerTransactionStatus.Processed) {
      throw new InvalidWagerReferenceError(
        FailureCode.InvalidReferenceKind,
        'The referenced transaction must be processed',
      );
    }

    this.assertReferenceContext(reference);
    this.assertReferenceKind(reference);

    if (this.requiresReference() && !this.money.equals(reference.money)) {
      throw new InvalidWagerReferenceError(
        FailureCode.ReferenceAmountMismatch,
        'The transaction amount must equal the referenced transaction amount',
      );
    }
  }

  private assertReferenceContext(reference: WagerTransaction): void {
    if (
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.roundId !== this.roundId ||
      reference.money.currency !== this.money.currency
    ) {
      throw new InvalidWagerReferenceError(
        FailureCode.ReferenceContextMismatch,
        'The referenced transaction belongs to a different wagering context',
      );
    }
  }

  private assertReferenceKind(reference: WagerTransaction): void {
    const isValid =
      (this.kind === WagerTransactionKind.Win && reference.kind === WagerTransactionKind.Bet) ||
      (this.kind === WagerTransactionKind.Refund && reference.kind === WagerTransactionKind.Bet) ||
      (this.kind === WagerTransactionKind.Rollback &&
        (reference.kind === WagerTransactionKind.Bet ||
          reference.kind === WagerTransactionKind.Win ||
          reference.kind === WagerTransactionKind.Refund));

    if (!isValid) {
      throw new InvalidWagerReferenceError(
        FailureCode.InvalidReferenceKind,
        `${this.kind} cannot reference ${reference.kind}`,
      );
    }
  }

  private moveToFailedState(
    status: WagerTransactionStatus.Rejected | WagerTransactionStatus.Failed,
    code: FailureCode,
    at: Date,
  ): void {
    this.assertNotTerminal();
    WagerTransaction.assertValidTimestamp(at);

    this._status = status;
    this._failureCode = code;
    this._processedAt = new Date(at);
  }
}
