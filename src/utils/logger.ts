import { AsyncLocalStorage } from "node:async_hooks";
import pino, { Logger, LoggerOptions } from "pino";

/**
 * Shared pino logger, also handed to Fastify as its own logger.
 *
 * Level: LOG_LEVEL (trace, debug, info, warn, error, fatal, silent), "info"
 * by default. Output: JSON lines, or pretty-printed when stdout is a
 * terminal and pino-pretty (a dev dependency) is installed.
 *
 * Every line logged while serving a request carries that request's `reqId`,
 * even from deep inside a module that only knows the shared logger — so the
 * outgoing Aurion calls of one request can be told apart from another's.
 */

const requestContext = new AsyncLocalStorage<string>();

/**
 * Fastify's per-request loggers already carry `reqId` as a binding: the
 * mixin must not add it a second time on them.
 */
const requestLoggers = new WeakSet<object>();

/** Query parameters whose value never reaches the logs. */
const SENSITIVE_PARAMS = /^(token|password|key|apikey|secret)$/i;

/** `url` with sensitive query parameter values replaced. */
export function safeUrl(url: string): string {
    const queryAt = url.indexOf("?");
    if (queryAt === -1) return url;
    const params = new URLSearchParams(url.slice(queryAt + 1));
    for (const name of [...params.keys()]) {
        if (SENSITIVE_PARAMS.test(name)) params.set(name, "[redacted]");
    }
    return `${url.slice(0, queryAt)}?${params.toString()}`;
}

function prettyTransport(): LoggerOptions["transport"] {
    if (!process.stdout.isTTY) return undefined;
    try {
        require.resolve("pino-pretty");
    } catch {
        return undefined;
    }
    return {
        target: "pino-pretty",
        options: {
            translateTime: "HH:MM:ss.l",
            ignore: "pid,hostname",
            singleLine: true,
        },
    };
}

const transport = prettyTransport();

export const logger: Logger = pino({
    level: process.env.LOG_LEVEL || "info",
    ...(transport ? { transport } : {}),
    // Credentials travel in request bodies and download tokens: belt and
    // braces in case one ever ends up in a logged object.
    redact: {
        paths: [
            "password",
            "*.password",
            "token",
            "*.token",
            "headers.authorization",
            "headers.cookie",
        ],
        censor: "[redacted]",
    },
    serializers: {
        err: pino.stdSerializers.err,
        // Fastify's request logs pass its request and reply objects here.
        req: (req: { method: string; url: string }) => ({
            method: req.method,
            url: safeUrl(req.url),
        }),
        res: (res: { statusCode: number }) => ({
            statusCode: res.statusCode,
        }),
    },
    mixin(_merge, _level, log) {
        const reqId = requestContext.getStore();
        return reqId && !requestLoggers.has(log) ? { reqId } : {};
    },
});

/** Fastify `childLoggerFactory`: builds the per-request loggers. */
export function requestChildLogger<
    L extends {
        child(bindings: pino.Bindings, options?: pino.ChildLoggerOptions): L;
    },
>(parent: L, bindings: pino.Bindings, options: pino.ChildLoggerOptions): L {
    const child = parent.child(bindings, options);
    requestLoggers.add(child);
    return child;
}

/** Run `fn` with `reqId` attached to everything it logs. */
export function runWithRequestId<T>(reqId: string, fn: () => T): T {
    return requestContext.run(reqId, fn);
}

/**
 * Message of an unknown thrown value, with its cause when it has one: `fetch`
 * only says "fetch failed" and keeps the real reason (DNS, refused…) there.
 */
export function errorMessage(error: unknown): string {
    if (!(error instanceof Error)) return String(error);
    const cause = error.cause instanceof Error ? error.cause.message : "";
    return cause && !error.message.includes(cause)
        ? `${error.message} (${cause})`
        : error.message;
}
