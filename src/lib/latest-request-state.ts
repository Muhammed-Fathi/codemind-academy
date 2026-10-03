export type LatestRequestStatus = "loading" | "success" | "error";

export type LatestRequestState<T, M = unknown> = {
  requestId: number;
  key: string;
  status: LatestRequestStatus;
  data: T | null;
  error: unknown | null;
  metadata: M | null;
};

export type LatestRequestAction<T, M = unknown> =
  | { type: "start"; requestId: number; key: string }
  | { type: "success"; requestId: number; key: string; data: T; metadata?: M | null }
  | { type: "error"; requestId: number; key: string; error: unknown };

/**
 * A tiny reducer for requests whose result must be scoped to the most recent
 * selection. Older success/error actions are ignored, and a current failure
 * clears the prior payload so stale data cannot masquerade as current.
 */
export function latestRequestReducer<T, M = unknown>(
  state: LatestRequestState<T, M>,
  action: LatestRequestAction<T, M>
): LatestRequestState<T, M> {
  if (action.type === "start") {
    if (action.requestId <= state.requestId) return state;
    return {
      ...state,
      requestId: action.requestId,
      key: action.key,
      status: "loading",
      data: null,
      error: null,
    };
  }

  if (action.requestId !== state.requestId || action.key !== state.key) {
    return state;
  }

  if (action.type === "success") {
    return {
      ...state,
      status: "success",
      data: action.data,
      error: null,
      metadata: action.metadata === undefined ? state.metadata : action.metadata,
    };
  }

  return {
    ...state,
    status: "error",
    data: null,
    error: action.error,
  };
}
