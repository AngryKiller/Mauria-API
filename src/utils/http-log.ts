import type { Hooks } from "got";
import { errorMessage, logger, safeUrl } from "./logger";

/**
 * Outgoing HTTP logging: one line per call with its service, method, URL,
 * status and duration. Failed (4xx/5xx), slow and aborted calls log as
 * warnings, so they show up even with LOG_LEVEL=warn.
 */

const log = logger.child({ module: "http" });

/** Calls slower than this log as warnings. */
const SLOW_MS = 10_000;

function logCall(
    fields: {
        service: string;
        method: string;
        url: string;
        status: number;
        ms: number;
        [extra: string]: unknown;
    }
): void {
    const failed = fields.status >= 400;
    const slow = fields.ms >= SLOW_MS;
    const message = failed
        ? "http call failed"
        : slow
          ? "http call slow"
          : "http call";
    if (failed || slow) {
        log.warn(fields, message);
    } else {
        log.info(fields, message);
    }
}

/** `got` hooks logging every call made by a client, tagged `service`. */
export function gotLogHooks(service: string): Partial<Hooks> {
    return {
        afterResponse: [
            (response) => {
                const location = response.headers.location;
                logCall({
                    service,
                    method: response.request.options.method,
                    url: safeUrl(response.requestUrl.toString()),
                    status: response.statusCode,
                    ms: Math.round(
                        response.timings.phases.total ??
                            Date.now() - response.timings.start
                    ),
                    bytes: response.rawBody?.length,
                    // Aurion clients don't follow redirects: where they point
                    // (the login page, typically) is often the whole story.
                    ...(location ? { location } : {}),
                });
                return response;
            },
        ],
        beforeRetry: [
            (error, retryCount) => {
                log.warn(
                    {
                        service,
                        method: error.options.method,
                        url: safeUrl(String(error.options.url ?? "")),
                        code: error.code,
                        retryCount,
                    },
                    "http call retried"
                );
            },
        ],
        beforeError: [
            (error) => {
                const start = error.timings?.start;
                log.warn(
                    {
                        service,
                        method: error.options.method,
                        url: safeUrl(String(error.options.url ?? "")),
                        status: error.response?.statusCode,
                        code: error.code,
                        ms: start ? Date.now() - start : undefined,
                        err: errorMessage(error),
                    },
                    "http call errored"
                );
                return error;
            },
        ],
    };
}

/** `fetch` that logs each call, tagged `service`. */
export function loggedFetch(service: string): typeof fetch {
    return async (input, init) => {
        const method =
            init?.method ?? (input instanceof Request ? input.method : "GET");
        const url = safeUrl(
            typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.href
                  : input.url
        );
        const start = Date.now();
        try {
            const res = await fetch(input, init);
            logCall({
                service,
                method,
                url,
                status: res.status,
                // Time to headers: the body is streamed by the caller.
                ms: Date.now() - start,
            });
            return res;
        } catch (error) {
            log.warn(
                {
                    service,
                    method,
                    url,
                    ms: Date.now() - start,
                    err: errorMessage(error),
                },
                "http call errored"
            );
            throw error;
        }
    };
}
