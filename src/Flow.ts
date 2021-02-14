import { Channel } from "./Channel";
import {
  FlowCompleteError,
  FlowConsumedError,
  FlowEmitError,
  FlowHasCompletedError,
  FlowRemoveObserverError
} from "./Errors";
import { Scope } from "./Scope";
import {
  CancelFunction,
  CoroutineFactory,
  Suspender,
  Observer,
  Consumer
} from "./Types";
import { suspend } from "./Util";

/**
 * Abstract class for emitting multiple values. Normally, a flow is cold and doesn't start producing
 * values until it is consumed with .collect() or another consuming method. Sharing a cold flow with
 * multiple coroutines requires converting it into a SharedEventSubject or SharedStateSubject.
 */
export abstract class Flow<T> {
  abstract addObserver(scope: Scope, observer: Observer<T>): void
  abstract removeObserver(observer: Observer<T>): void

  /**
   * Converts values emitted using mapper function.
   * @param mapper
   */
  map<R>(mapper: (value: T) => R): Flow<R> {
    return new MapFlow<T, R>(this, mapper);
  }

  /**
   * Values that don't return true from predicate function are not emitted.
   * @param predicate
   */
  filter(predicate: (value: T) => boolean): Flow<T> {
    return new FilterFlow(this, predicate);
  }

  /**
   * Runs binder on each emitted value and combines outputs into a single flow.
   * @param binder
   */
  flatMap<R>(binder: (value: T) => Flow<R>): Flow<R> {
    return new FlatMapFlow(this, binder);
  }

  /**
   * Runs f on each value but doesn't change values emitted in downstream flow.
   * @param f
   */
  onEach(f: (value: T) => void): Flow<T> {
    return new OnEachFlow(this, f);
  }

  /**
   * Consumes values in upstream Flow. Shares values with downstream flow. Replays last value
   * emitted on new observers.
   */
  sharedState(): Flow<T> {
    return new SharedStateFlow<T>(this);
  }

  /**
   * Consumes values in upstream Flow. Shares values with downstream flow.
   */
  sharedEvent(): Flow<T> {
    return new SharedEventFlow<T>(this);
  }

  /**
   * Consumes Flow in scope, ignoring emitted vaues.
   * @param scope
   */
  launchIn(scope: Scope) {
    const that = this;
    scope.launch(function*() {
      yield scope.collect(that, () => undefined);
    });
  }

  /**
   * Consumes Flow in scope. Runs collector function on emitted values.
   * @param scope
   * @param collector
   */
  collect(scope: Scope, collector: (value: T) => void): Suspender<void> {
    return scope.collect(this, collector);
  }

  /**
   * Consumes Flow in scope. Runs collector coroutine on emitted values. Cancels previously started
   * coroutine if it has not completed.
   * @param scope
   * @param factory
   */
  collectLatest(scope: Scope, factory: (value: T) => CoroutineFactory<void>): Suspender<void> {
    return scope.collectLatest(this, factory);
  }

  /**
   * Runs coroutine on each value and emits values through observer. Waits for each
   * coroutine to complete before starting the next. Because there is no backpressure with flow, use
   * care to make sure that emitted values don't buffer uncontrollably.
   * @param transformer
   */
  transform<R>(
    transformer: (value: T, consumer: Observer<R>) => CoroutineFactory<void>,
  ): Flow<R> {
    return new TransformFlow(this, transformer);
  }

  /**
   * Errors thrown upstream are caught and passed into coroutine factory. Resumes sending values
   * emitted to observer.
   * @param factory
   */
  catch(factory: (error: unknown, consumer: Consumer<T>) => CoroutineFactory<void>): Flow<T> {
    return new TransformCatch(this, factory);
  }

  /**
   * Runs a coroutine on each value and emits values through observer. Cancels previous coroutine if
   * it has not completed.
   * @param transformer
   */
  transformLatest<R>(
    transformer: (value: T, consumer: Consumer<R>) => CoroutineFactory<void>,
  ): Flow<R> {
    return new TransformLatestFlow(this, transformer);
  }
}

class MapFlow<T, R> extends Flow<R> implements Observer<T> {
  private observer?: Observer<R>;
  private hasCompleted = false;

  constructor(private flow: Flow<T>, private mapper: (value: T) => R) {
    super();
  }

  addObserver(scope: Scope, observer: Observer<R>): void {
    if (this.observer !== undefined) {
      throw new FlowConsumedError();
    }

    this.observer = observer;
    this.flow.addObserver(scope, this);
  }

  removeObserver(observer: Observer<R>): void {
    if (this.observer !== observer) {
      throw new FlowRemoveObserverError();
    }

    this.flow.removeObserver(this);
  }

  emit(value: T) {
    if (this.observer === undefined) {
      throw new FlowEmitError();
    }

    if (this.hasCompleted) {
      throw new FlowHasCompletedError();
    }

    this.observer.emit(this.mapper(value));
  }

  complete() {
    if (this.observer === undefined) {
      throw new FlowCompleteError();
    }

    if (this.hasCompleted) {
      throw new FlowHasCompletedError();
    }

    this.hasCompleted = true;
    this.observer.complete();
  }
}

class FilterFlow<T> extends Flow<T> implements Observer<T> {
  private observer?: Observer<T>;
  private hasCompleted = false;

  constructor(private flow: Flow<T>, private predicate: (value: T) => boolean) {
    super();
  }

  addObserver(scope: Scope, observer: Observer<T>): void {
    if (this.observer !== undefined) {
      throw new FlowConsumedError();
    }

    this.observer = observer;
    this.flow.addObserver(scope, this);
  }

  removeObserver(observer: Observer<T>): void {
    if (this.observer !== observer) {
      throw new FlowRemoveObserverError();
    }

    this.flow.removeObserver(this);
  }

  emit(value: T): void {
    if (this.observer === undefined) {
      throw new FlowEmitError();
    }

    if (this.hasCompleted) {
      throw new FlowHasCompletedError();
    }

    if (this.predicate(value)) {
      this.observer.emit(value);
    }
  }

  complete() {
    if (this.observer === undefined) {
      throw new FlowCompleteError();
    }

    if (this.hasCompleted) {
      throw new FlowHasCompletedError();
    }

    this.hasCompleted = true;
    this.observer.complete();
  }
}

class FlatMapFlow<T, R> extends Flow<R> implements Observer<T> {
  private scope?: Scope;
  private observer?: Observer<R>;
  private hasCompleted = false;

  constructor(private flow: Flow<T>, private binder: (value: T) => Flow<R>) {
    super();
  }

  addObserver(scope: Scope, observer: Observer<R>): void {
    if (this.observer !== undefined) {
      throw new FlowConsumedError();
    }

    this.scope = scope;
    this.observer = observer;
    this.flow.addObserver(scope, this);
  }

  removeObserver(observer: Observer<R>): void {
    if (this.observer !== observer) {
      throw new FlowRemoveObserverError();
    }

    this.flow.removeObserver(this);
  }

  emit(value: T): void {
    if (this.observer === undefined || this.scope === undefined) {
      throw new FlowEmitError();
    }

    if (this.hasCompleted) {
      throw new FlowHasCompletedError();
    }

    this.binder(value).addObserver(this.scope, this.observer);
  }

  complete() {
    if (this.observer === undefined) {
      throw new FlowCompleteError();
    }

    if (this.hasCompleted) {
      throw new FlowHasCompletedError();
    }

    this.hasCompleted = true;
    this.observer.complete();
  }
}

class OnEachFlow<T> extends Flow<T> implements Observer<T> {
  private observer?: Observer<T>;
  private hasCompleted = false;

  constructor(private flow: Flow<T>, private f: (value: T) => void) {
    super();
  }

  addObserver(scope: Scope, observer: Observer<T>): void {
    if (this.observer !== undefined) {
      throw new FlowConsumedError();
    }

    this.observer = observer;
    this.flow.addObserver(scope, this);
  }

  removeObserver(observer: Observer<T>): void {
    if (this.observer === observer) {
      this.flow.removeObserver(this);
    } else {
      throw new FlowConsumedError();
    }
  }

  emit(value: T): void {
    if (this.observer === undefined) {
      throw new FlowEmitError();
    }

    if (this.hasCompleted) {
      throw new FlowHasCompletedError();
    }

    this.f(value);
    this.observer.emit(value);
  }

  complete() {
    if (this.observer === undefined) {
      throw new FlowCompleteError();
    }

    if (this.hasCompleted) {
      throw new FlowHasCompletedError();
    }

    this.observer.complete();
  }
}

class TransformFlow<T, R> extends Flow<R> implements Observer<T> {
  private scope?: Scope;
  private observer?: Observer<R>;
  private receiverChannel?: Channel<T>;
  private hasCompleted = false;

  constructor(
    private flow: Flow<T>,
    private f: (value: T, observer: Observer<R>) => CoroutineFactory<void>,
  ) {
    super();
  }

  addObserver(scope: Scope, observer: Observer<R>): void {
    if (this.observer !== undefined) {
      throw new FlowConsumedError();
    }

    this.scope = scope;
    this.observer = observer;
    this.flow.addObserver(scope, this);

    const receiverChannel = new Channel<T>({ bufferSize: Infinity });
    this.receiverChannel = receiverChannel;
    const f = this.f;
    const transformFlow = this;

    this.scope.launch(function*() {
      // TODO complete if canceled with no items queued
      while (!transformFlow.hasCompleted) {
        yield* this.call(f(yield* suspend(receiverChannel.receive), observer));
      }
    });
  }

  removeObserver(observer: Observer<R>): void {
    if (this.observer === observer) {
      this.flow.removeObserver(this);
    } else {
      throw new FlowConsumedError();
    }
  }

  emit(value: T): void {
    if (this.receiverChannel === undefined) {
      throw new FlowEmitError();
    }

    if (this.hasCompleted) {
      throw new FlowHasCompletedError();
    }

    // channel buffer is Infinite so we don't check for failure
    this.receiverChannel.trySend(value);
  }

  complete() {
    if (this.observer === undefined) {
      throw new FlowCompleteError();
    }

    if (this.hasCompleted) {
      throw new FlowHasCompletedError();
    }

    this.hasCompleted = true;
  }
}

class TransformCatch<T> extends Flow<T> implements Observer<T> {
  private observer?: Observer<T>;
  private hasCompleted = false;

  constructor(
    private flow: Flow<T>,
    private factory: (error: unknown, observer: Observer<T>) => CoroutineFactory<void>,
  ) {
    super();
  }

  addObserver(scope: Scope, observer: Observer<T>): void {
    if (this.observer !== undefined) {
      throw new FlowConsumedError();
    }

    this.observer = observer;

    this.flow.addObserver(
      new Scope({ errorCallback: (error) => {
        scope.launch(this.factory(error, this));
      }}),
      this,
    );
  }

  removeObserver(observer: Observer<T>): void {
    if (this.observer === observer) {
      this.flow.removeObserver(this);
    } else {
      throw new FlowConsumedError();
    }
  }

  emit(value: T): void {
    if (this.observer === undefined) {
      throw new FlowEmitError();
    }

    if (this.hasCompleted) {
      throw new FlowHasCompletedError();
    }

    this.observer.emit(value);
  }

  complete() {
    if (this.observer === undefined) {
      throw new FlowEmitError();
    }

    if (this.hasCompleted) {
      throw new FlowHasCompletedError();
    }

    this.hasCompleted = true;
    this.observer.complete();
  }
}

class TransformLatestFlow<T, R> extends Flow<R> {
  private observer?: Observer<R>;
  private cancel?: CancelFunction;

  constructor(
    private flow: Flow<T>,
    private f: (value: T, consumer: Consumer<R>) => CoroutineFactory<void>,
  ) {
    super();
  }

  addObserver(scope: Scope, observer: Observer<R>): void {
    if (this.observer !== undefined) {
      throw new FlowConsumedError();
    }

    this.observer = observer;
    this.cancel = scope.transformLatest(this.flow, this.f, observer);
  }

  removeObserver(observer: Observer<R>): void {
    if (this.observer === observer) {
      this.cancel?.call(null);
    } else {
      throw new FlowConsumedError();
    }
  }
}

class FlowOf<T> extends Flow<T> {
  private observer?: Observer<T>;
  private cancel?: CancelFunction;

  constructor(
    private factory: (observer: Observer<T>) => CoroutineFactory<void>,
  ) {
    super();
  }

  addObserver(scope: Scope, observer: Observer<T>): void {
    if (this.observer !== undefined) {
      throw new FlowConsumedError();
    }

    this.observer = observer;
    this.cancel = scope.launch(this.factory(observer));
  }

  removeObserver(observer: Observer<T>): void {
    if (this.observer === observer) {
      this.cancel!();
    } else {
      throw new FlowConsumedError();
    }
  }
}

export const flowOf = <T>(factory: (consumer: Consumer<T>) => CoroutineFactory<void>): Flow<T> =>
  new FlowOf(factory);

class FlowOfValues<T> extends Flow<T> {
  private values: Array<T>;

  constructor(...args: Array<T>) {
    super();
    this.values = args;
  }

  addObserver(scope: Scope, observer: Observer<T>): void {
    for (const value of this.values) {
      observer.emit(value);
    }

    observer.complete();
  }

  removeObserver(observer: Observer<T>): void {
  }
}

export const flowOfValues = <T>(...args: Array<T>): Flow<T> =>
  new FlowOfValues(...args);

/**
 * Starts observing a upstream flow and shares received values to downstream observers.
 * SharedStateFlow replay the last emitted value to new observers.
 */
export class SharedStateFlow<T> extends Flow<T> implements Observer<T> {
  private observers = new Set<Observer<T>>();
  private last?: { value: T };
  private hasCompleted = false;

  constructor(private flow: Flow<T>) {
    super();
    this.flow.addObserver(Scope.nonCanceling, this);
  }

  addObserver(scope: Scope, observer: Observer<T>): void {
    this.observers.add(observer);

    if (this.last !== undefined) {
      observer.emit(this.last.value);
    }

    if (this.hasCompleted) {
      observer.complete();
    }
  }

  removeObserver(observer: Observer<T>): void {
    this.observers.delete(observer);
  }

  emit(value: T): void {
    if (this.hasCompleted) {
      throw new FlowHasCompletedError();
    }

    this.last = { value };

    for (const observer of this.observers) {
      observer.emit(value);
    }
  }

  complete() {
    if (this.hasCompleted) {
      throw new FlowHasCompletedError();
    }

    this.hasCompleted = true;

    for (const observer of this.observers) {
      observer.complete();
    }
  }
}

/**
 * EventSubjects update their observers when there is a new event. Previously emitted values are not
 * replayed on new observers. To replay the last emitted value, use StateSubject. Subjects are hot
 * and can be shared with multipler observers. New flows that observe subjects start cold.
 */
export class EventSubject<T> extends Flow<T> implements Consumer<T> {
  private observers: Set<Observer<T>> = new Set();

  addObserver(scope: Scope, observer: Observer<T>): void {
    this.observers.add(observer);
  }

  removeObserver(observer: Observer<T>): void {
    this.observers.delete(observer);
  }

  /**
   * Emits a value to the observer.
   * @param value
   */
  emit(value: T): void {
    for (const observer of this.observers) {
      observer.emit(value);
    }
  }
}

/**
 * StateSubject always have a value. When new observers are added, the last emitted value is
 * replayed. This is generally used used for hot observables like the mouse position. Subjects are
 * hot and can be shared with multipler observers. New flows that observe subjects start cold.
 */
export class StateSubject<T> extends Flow<T> implements Consumer<T> {
  private observers: Set<Observer<T>> = new Set()

  constructor(public value: T) {
    super();
  }

  addObserver(scope: Scope, observer: Observer<T>): void {
    this.observers.add(observer);
    observer.emit(this.value);
  }

  removeObserver(observer: Observer<T>): void {
    this.observers.delete(observer);
  }

  emit(value: T): void {
    this.value = value;

    for (const observer of this.observers) {
      observer.emit(value);
    }
  }

  get(): T {
    return this.value;
  }
}

/**
 * Starts observing a upstream flow and shares received values to downstream observers.
 * SharedEventFlow doesn't replay any past emitted values.
 */
export class SharedEventFlow<T> extends Flow<T> implements Observer<T> {
  private observers = new Set<Observer<T>>();
  private hasCompleted = false;

  constructor(private flow: Flow<T>) {
    super();
    this.flow.addObserver(Scope.nonCanceling, this);
  }

  addObserver(scope: Scope, observer: Observer<T>): void {
    this.observers.add(observer);
  }

  removeObserver(observer: Observer<T>): void {
    this.observers.delete(observer);
  }

  emit(value: T): void {
    if (this.hasCompleted) {
      throw new FlowHasCompletedError();
    }

    for (const observer of this.observers) {
      observer.emit(value);
    }
  }

  complete() {
    if (this.hasCompleted) {
      throw new FlowHasCompletedError();
    }

    this.hasCompleted = true;

    for (const observer of this.observers) {
      observer.complete();
    }
  }
}
