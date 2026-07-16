function requireHook(adapter, name) {
  if (typeof adapter?.[name] !== "function") {
    throw new TypeError(`browser agent adapter requires a ${name}() hook`);
  }
}

function stopped(shouldStop, signal) {
  return signal?.aborted === true || shouldStop?.() === true;
}

/**
 * Domain-neutral observe → classify → plan → execute loop.
 *
 * Domain profiles provide the adapter hooks. The loop intentionally knows
 * nothing about applications, listings, resumes, traffic, or submission.
 */
export function createAgentCore(adapter = {}) {
  requireHook(adapter, "observe");
  requireHook(adapter, "plan");
  requireHook(adapter, "execute");

  const classify =
    typeof adapter.classify === "function"
      ? adapter.classify
      : async (state) => state;
  const isDone =
    typeof adapter.isDone === "function"
      ? adapter.isDone
      : async () => false;
  const onEvent =
    typeof adapter.onEvent === "function"
      ? adapter.onEvent
      : async () => {};

  return Object.freeze({
    profile: adapter.profile || null,

    async run({
      context = {},
      maxSteps = adapter.profile?.settings?.agent_max_steps || 24,
      shouldStop = null,
      signal = null,
      initialState = null,
    } = {}) {
      const limit = Math.max(1, Number(maxSteps) || 1);
      const history = [];
      let state = initialState;
      let classification = null;
      let outcome = null;
      let status = "max_steps";

      for (let step = 1; step <= limit; step += 1) {
        if (stopped(shouldStop, signal)) {
          status = "stopped";
          await onEvent({ type: "stopped", step, state, history, context });
          break;
        }

        state = await adapter.observe({
          step,
          state,
          history,
          context,
          signal,
        });
        classification = await classify(state, {
          step,
          history,
          context,
          signal,
        });

        if (
          await isDone({
            phase: "observed",
            step,
            state,
            classification,
            history,
            context,
          })
        ) {
          status = "done";
          break;
        }

        const action = await adapter.plan({
          step,
          state,
          classification,
          history,
          context,
          signal,
        });

        if (!action) {
          status = "no_action";
          await onEvent({
            type: "no_action",
            step,
            state,
            classification,
            history,
            context,
          });
          break;
        }

        await onEvent({
          type: "action_started",
          step,
          action,
          state,
          classification,
          history,
          context,
        });

        const result =
          (await adapter.execute({
            step,
            action,
            state,
            classification,
            history,
            context,
            signal,
          })) || {};

        if (Object.hasOwn(result, "state")) state = result.state;
        if (Object.hasOwn(result, "outcome")) outcome = result.outcome;

        const entry = {
          step,
          action,
          ok: result.ok !== false,
          progress: result.progress === true,
          result,
        };
        history.push(entry);

        await onEvent({
          type: "action_finished",
          step,
          action,
          result,
          state,
          classification,
          history,
          context,
        });

        if (
          result.done === true ||
          (await isDone({
            phase: "executed",
            step,
            action,
            result,
            state,
            classification,
            history,
            context,
          }))
        ) {
          status = "done";
          break;
        }
      }

      return {
        status,
        state,
        classification,
        outcome,
        history,
        steps: history.length,
      };
    },
  });
}

export async function runAgentCore(adapter, options) {
  return createAgentCore(adapter).run(options);
}
