// PageParser.ts

import { logger } from "../../../utils/logger";

const log = logger.child({ module: "aurion-parser" });

export class PageParser {
    /**
     * Log what the page actually was, then throw. The title alone usually
     * tells the story (the login page on a stale session, an error page…);
     * the start of the body follows at debug level.
     */
    private static fail(message: string, body: string): never {
        const page = {
            title: body.match(/<title>([^<]*)<\/title>/)?.[1]?.trim(),
            partial: body.includes("<partial-response"),
            bytes: body.length,
        };
        log.warn({ page }, message);
        log.debug({ snippet: body.slice(0, 3000) }, `${message}: page start`);
        throw new Error(message);
    }

    static parseViewState(body: string): string {
        const match = body.match(
            /<input type="hidden" name="javax.faces.ViewState" id="j_id1:javax.faces.ViewState:0" value="([^"]+)" autocomplete="off" \/>/
        );
        if (!match) PageParser.fail("ViewState non trouvé", body);
        return match[1]!;
    }

    static parseFormId(body: string): string {
        const from = "{PrimeFaces.ab({s:";
        const to = ",f:";
        const snippet = body.substring(
            body.indexOf(">chargerSousMenu = function()"),
            body.indexOf(">chargerSousMenu = function()") + 300
        );
        const idxFrom = snippet.indexOf(from);
        const idxTo = snippet.indexOf(to);
        if (idxFrom === -1 || idxTo === -1)
            PageParser.fail("FormId non trouvé", body);
        return snippet
            .substring(idxFrom + from.length, idxTo)
            .replace(/"/g, "");
    }

    static parseIdInit(body: string): string {
        const from = 'name="form:idInit" value="';
        const startIndex = body.indexOf(from);
        if (startIndex === -1) PageParser.fail("idInit non trouvé", body);
        const idxTo = body.indexOf('"', startIndex + from.length);
        return body.substring(startIndex + from.length, idxTo);
    }

    static parseMenuId(body: string, keyword = "Mes notes</span>"): string {
        const searchStart = body.indexOf(keyword) - 300;
        const searchEnd = body.indexOf(keyword);
        if (searchStart < 0 || searchEnd < 0)
            PageParser.fail("MenuId zone non trouvée", body);
        const snippet = body.substring(searchStart, searchEnd);
        const from = "form:sidebar_menuid':'";
        const to = "'})";
        const idxFrom = snippet.indexOf(from);
        const idxTo = snippet.indexOf(to);
        if (idxFrom === -1 || idxTo === -1)
            PageParser.fail("MenuId non trouvé", body);
        return snippet.substring(idxFrom + from.length, idxTo);
    }

    static parseFormIdGrade(body: string): string {
        const to = "Date Ascending";
        const snippet = body.substring(
            body.indexOf(to) - 400,
            body.indexOf(to)
        );
        const from = `<div class="EmptyBox10"></div><div id="form:`;
        const toDelim = `" class="ui-datatable ui-widget`;
        const idxFrom = snippet.indexOf(from);
        const idxTo = snippet.indexOf(toDelim);
        if (idxFrom === -1 || idxTo === -1)
            PageParser.fail("FormIdGrade non trouvé", body);
        return snippet.substring(idxFrom + from.length, idxTo);
    }

    static parseFormIdPlanning(body: string): string {
        const regex = /PrimeFaces\.cw\("Schedule","schedule",\{id:"([^"]+)"/;
        const match = body.match(regex);
        if (!match || match.length < 2 || !match[1]) {
            PageParser.fail("FormIdPlanning non trouvé", body);
        }
        const fullId = match[1];
        return fullId;
    }

    private static extractSpan(cell?: string): string {
        if (!cell) return "";
        const match = cell.match(/<span class="preformatted ">([^<]+)<\/span>/);
        return match ? match[1]! : "";
    }

    /**
     * "form:sidebar_menuid" of the sidebar leaf labelled `labelPattern`.
     * Top-level leaves carry a plain number, lazy-loaded ones a position
     * path such as "5_0".
     */
    static parseSidebarMenuId(
        body: string,
        labelPattern: string
    ): string | null {
        return PageParser.sidebarIdBefore(
            body,
            labelPattern,
            /'form:sidebar_menuid':'([^']+)'/g
        );
    }

    /** Id of the lazy-loaded sidebar submenu labelled `labelPattern`. */
    static parseSidebarSubmenuId(
        body: string,
        labelPattern: string
    ): string | null {
        return PageParser.sidebarIdBefore(body, labelPattern, /submenu_(\d+)/g);
    }

    /**
     * Sidebar ids sit in the markup right before the entry's label: the last
     * one before the label is the entry's own, earlier ones are siblings'.
     * `labelPattern` is a regex source, so accented labels can match both
     * their raw and their HTML-escaped spelling. Matched case-insensitively:
     * schools capitalise labels differently ("Mon Planning", "Mon planning").
     */
    private static sidebarIdBefore(
        body: string,
        labelPattern: string,
        idRegex: RegExp
    ): string | null {
        const at = body.search(
            new RegExp(
                `<span class="ui-menuitem-text">\\s*${labelPattern}\\s*</span>`,
                "i"
            )
        );
        if (at === -1) return null;
        const ids = [...body.slice(Math.max(0, at - 600), at).matchAll(idRegex)];
        return ids.at(-1)?.[1] ?? null;
    }

    /** Partial responses carry a refreshed ViewState to use for the next call. */
    static parsePartialViewState(body: string): string {
        return (
            body.match(
                /<update id="[^"]*javax\.faces\.ViewState[^"]*"><!\[CDATA\[([^\]]+)\]\]><\/update>/
            )?.[1] ?? ""
        );
    }

    static parseGrades(body: string): any[] {
        const gradeRows = body.match(/<tr[^>]*>([\s\S]*?)<\/tr>/g);
        if (!gradeRows) {
            PageParser.fail("Erreur: récupération des notes", body);
        }
        if (gradeRows.length === 0) {
            PageParser.fail("Erreur: aucune note trouvée", body);
        }
        return gradeRows.map((row) => {
            const cells = row.match(/<td[^>]*>([\s\S]*?)<\/td>/g) || [];
            return {
                date: PageParser.extractSpan(cells[0]),
                code: PageParser.extractSpan(cells[1]),
                name: PageParser.extractSpan(cells[2]),
                grade: PageParser.extractSpan(cells[3]),
                coefficient: PageParser.extractSpan(cells[4]),
                average: PageParser.extractSpan(cells[5]),
                min: PageParser.extractSpan(cells[6]),
                max: PageParser.extractSpan(cells[7]),
                median: PageParser.extractSpan(cells[8]),
                standardDeviation: PageParser.extractSpan(cells[9]),
                comment: PageParser.extractSpan(cells[10]),
            };
        });
    }

    static parseAbsences(body: string): any[] {
        const absRows = body.match(/<tr data-ri="[^>]*>([\s\S]*?)<\/tr>/g);
        if (!absRows) {
            PageParser.fail("Erreur: récupération des absences", body);
        }
        if (absRows.length === 0) {
            PageParser.fail("Erreur: aucune absence trouvée", body);
        }
        return absRows.map((row) => {
            const date = (row.match(
                /<td role="gridcell" style="text-align: left">([^<]+)<\/td>/
            ) || [, ""])[1];
            const cells = [
                ...row.matchAll(/<td role="gridcell">([^<]*)<\/td>/g),
            ].map((m) => m[1]);
            return {
                date,
                type: cells[0],
                duration: cells[1],
                time: cells[2],
                class: cells[3],
                teacher: cells[4],
            };
        });
    }
}
