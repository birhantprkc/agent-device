import { setTimeout as sleep } from 'node:timers/promises';
import { AppError } from '@agent-device/kernel/errors';
import { agentDeviceRequestHeaders } from './request-headers.ts';
import { basicAuthHeader, trimLeadingSlash, withTrailingSlash } from './webdriver-utils.ts';

export type WebDriverAuth = {
  username: string;
  accessKey: string;
};

export type WebDriverRequestPolicy = {
  timeoutMs?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
};

export type WebDriverRequestOverrides = {
  retryAttempts?: number;
  /**
   * Per-request transport bound, for callers whose own budget is far shorter
   * than the client's default. Without it a caller waiting 2s on a poll can be
   * held for the full default timeout by one hung request.
   */
  timeoutMs?: number;
  /** Request-bound cancellation supplied by a runtime binding. */
  signal?: AbortSignal;
};

export type WebDriverTransportOptions = {
  clientVersion: string;
  endpoint: string | URL;
  auth?: WebDriverAuth;
  headers?: Record<string, string>;
  requestPolicy?: WebDriverRequestPolicy;
};

type WebDriverResponse = {
  value?: unknown;
  sessionId?: string;
};

type ResolvedWebDriverRequestOverrides = {
  timeoutMs: number;
  retryAttempts: number;
  signal?: AbortSignal;
};

/** Focused HTTP/retry policy for one WebDriver endpoint; session semantics stay in WebDriverClient. */
export class WebDriverTransport {
  private readonly endpoint: URL;
  private readonly headers: Record<string, string>;
  private readonly requestPolicy: Required<WebDriverRequestPolicy>;

  constructor(options: WebDriverTransportOptions) {
    this.endpoint = withTrailingSlash(new URL(options.endpoint));
    this.headers = {
      ...agentDeviceRequestHeaders(options.clientVersion),
      ...(options.auth ? { Authorization: basicAuthHeader(options.auth) } : {}),
      ...options.headers,
    };
    this.requestPolicy = {
      timeoutMs: options.requestPolicy?.timeoutMs ?? 30_000,
      retryAttempts: options.requestPolicy?.retryAttempts ?? 1,
      retryDelayMs: options.requestPolicy?.retryDelayMs ?? 250,
    };
  }

  async requestValue(
    method: string,
    path: string,
    body?: unknown,
    overrides?: WebDriverRequestOverrides,
  ): Promise<unknown> {
    return await this.requestValueWithRetries(method, path, body, {
      retryAttempts: overrides?.retryAttempts ?? this.requestPolicy.retryAttempts,
      timeoutMs: overrides?.timeoutMs ?? this.requestPolicy.timeoutMs,
      signal: overrides?.signal,
    });
  }

  private async requestValueWithRetries(
    method: string,
    path: string,
    body: unknown,
    overrides: ResolvedWebDriverRequestOverrides,
  ): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= overrides.retryAttempts; attempt += 1) {
      try {
        return await this.requestValueOnce(
          method,
          path,
          body,
          overrides.timeoutMs,
          overrides.signal,
        );
      } catch (error) {
        lastError = error;
        if (
          !shouldRetryWebDriverRequest(error, attempt, overrides.retryAttempts, overrides.signal)
        ) {
          throw error;
        }
        await sleep(this.requestPolicy.retryDelayMs, undefined, { signal: overrides.signal });
      }
    }
    throw lastError;
  }

  private async requestValueOnce(
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number,
    requestSignal?: AbortSignal,
  ): Promise<unknown> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = requestSignal ? AbortSignal.any([requestSignal, timeoutSignal]) : timeoutSignal;
    const response = await fetch(new URL(trimLeadingSlash(path), this.endpoint), {
      method,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...this.headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const text = await response.text();
    const payload = text ? parseJsonResponse(text) : {};
    if (!response.ok) {
      throw webdriverError(response.status, payload);
    }
    return readWebDriverValue(payload);
  }
}

function shouldRetryWebDriverRequest(
  error: unknown,
  attempt: number,
  retryAttempts: number,
  signal: AbortSignal | undefined,
): boolean {
  return !signal?.aborted && isRetriableWebDriverError(error) && attempt < retryAttempts;
}

function readWebDriverValue(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const response = payload as WebDriverResponse;
  if ('value' in response) return response.value;
  return payload;
}

function parseJsonResponse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new AppError('COMMAND_FAILED', 'WebDriver response was not valid JSON.', { text }, error);
  }
}

function webdriverError(status: number, payload: unknown): AppError {
  const value =
    payload && typeof payload === 'object' && 'value' in payload
      ? (payload as { value?: unknown }).value
      : payload;
  const message =
    value &&
    typeof value === 'object' &&
    typeof (value as { message?: unknown }).message === 'string'
      ? (value as { message: string }).message
      : `WebDriver request failed with HTTP ${status}.`;
  return new AppError('COMMAND_FAILED', message, { status, response: payload });
}

function isRetriableWebDriverError(error: unknown): boolean {
  if (error instanceof AppError) {
    const status = error.details?.status;
    return typeof status === 'number' && status >= 500;
  }
  return error instanceof TypeError || (error instanceof Error && error.name === 'TimeoutError');
}
