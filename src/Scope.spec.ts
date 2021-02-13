import { Scope } from "./Scope";
import { awaitCancelation, suspend, wait } from "./Util";

describe(`Scope tests`, () => {
  it(`race cancels slower coroutine 1`, (done) => {
    new Scope({ errorCallback: (error) => { done(error); }})
      .launch(function* () {
        let finallyCalled = false

        const result = yield* suspend(this.race(
          this.callAsync(function* () {
            yield wait(0);
            return 0;
          }),
          this.callAsync(function* () {
            try {
              yield wait(5);
              done(`this should not run`);
              this.cancel();
              return 1;
            } finally {
              finallyCalled = true;
            }
          }),
        ));

        if (result === 0 && finallyCalled) {
          done();
        } else {
          done(`result: ${result} finallyCalled: ${finallyCalled}`);
        }

        this.cancel();
      });
  });

  it(`race cancels slower coroutine 2`, (done) => {
    new Scope({ errorCallback: (error) => { done(error); }})
      .launch(function* () {
        let finallyCalled = false

        const result = yield* suspend(this.race(
          this.callAsync(function* () {
            try {
              yield wait(5);
              done(`this should not run`);
              this.cancel();
              return 1;
            } finally {
              finallyCalled = true;
            }
          }),
          this.callAsync(function* () {
            yield wait(0);
            return 0;
          }),
        ));

        if (result === 0 && finallyCalled) {
          done();
        } else {
          done(`result: ${result} finallyCalled: ${finallyCalled}`);
        }

        this.cancel();
      });
  });

  it(`sibling coroutine is canceled when scope is canceled`, (done) => {
    const scope = new Scope();

    scope.launch(function* () {
      try {
        yield wait(5);
      } finally {
        done();
      }
    });

    scope.launch(function* () {
      throw new Error();
    });
  });

  it(`coroutine is canceled when scope is canceled`, (done) => {
    const scope = new Scope();

    scope.launch(function* () {
      try {
        yield awaitCancelation();
      } finally {
        done();
      }
    });

    scope.cancel();
  });

  it(`canceling a coroutine doesn't cancel it's scope`, (done) => {
    const scope = new Scope({ errorCallback: (error) => { done(error); }});

    const cancelFunction = scope.launch(function* () {
      yield awaitCancelation();
    });

    cancelFunction();

    scope.launch(function* () {
      done();
    });
  });

  it(`throwing in non-canceling scope doesn't cancel it`, (done) => {
    const scope = new Scope({ isCancelable: false, errorCallback: (error) => { done(error); }});

    scope.launch(function* () {
      throw new Error();
    });

    if (!scope.isActive()) {
      done(`scope is no longer active after throw`);
    }

    scope.launch(function*() {
      done();
    });
  });
});
