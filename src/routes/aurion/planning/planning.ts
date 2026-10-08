import { PageParser } from "../utils/page-parser";
import { SessionManager } from "../utils/session-manager";
import { logger } from "../../../utils/logger";

const log = logger.child({ module: "aurion-planning" });

/** Sidebar labels, as regex sources (Aurion may HTML-escape the accent). */
const MON_PLANNING = "Mon Planning";
const SCOLARITE = "Scolarit(?:é|&eacute;|&#233;)";

export class AurionPlanning {
    private sessionManager: SessionManager;

    private viewState = "";
    private formId = "";
    private menuid = "";
    private idInit = "";
    private formIdPlanning = "";

    constructor(sessionManager: SessionManager) {
        this.sessionManager = sessionManager;
    }

    async initializeSession() {
        const homeState = await this.sessionManager.fetchHomePageState();
        this.viewState = homeState.viewState;
        this.formId = homeState.formId;
        this.idInit = homeState.idInit;
    }

    /**
     * Click "Mon Planning" in the sidebar. Some schools list it at the top
     * level of the menu, others inside the lazy-loaded "Scolarité" submenu,
     * which then has to be expanded first.
     */
    async postMainSidebar() {
        const base = this.sessionManager.baseUrl;
        const menuPage = await this.sessionManager.client.get(
            `${base}/faces/MainMenuPage.xhtml`,
            {
                headers: {
                    Referer: `${base}/`,
                    Connection: "keep-alive",
                },
                responseType: "text",
            }
        );
        this.viewState = PageParser.parseViewState(menuPage.body);

        const topLevel = PageParser.parseSidebarMenuId(
            menuPage.body,
            MON_PLANNING
        );
        this.menuid = topLevel ?? (await this.expandScolarite(menuPage.body));
        log.debug(
            { menuid: this.menuid, inScolarite: topLevel === null },
            "« Mon Planning » menu entry found"
        );

        const postData = new URLSearchParams({
            form: "form",
            "form:largeurDivCenter": "885",
            "form:idInit": this.idInit,
            "form:sauvegarde": "",
            "form:j_idt773_focus": "",
            "form:j_idt773_input": "44323",
            "javax.faces.ViewState": this.viewState,
            "form:sidebar": "form:sidebar",
            "form:sidebar_menuid": this.menuid,
        }).toString();

        const post = await this.sessionManager.client.post(
            `${base}/faces/MainMenuPage.xhtml`,
            {
                body: postData,
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                responseType: "text",
            }
        );
        const target = post.headers.location
            ? new URL(post.headers.location, base).toString()
            : `${base}/faces/Planning.xhtml`;

        const getRes = await this.sessionManager.client.get(target, {
            headers: {
                Referer: `${base}/faces/MainMenuPage.xhtml`,
                Connection: "keep-alive",
            },
            responseType: "text",
        });

        this.viewState = PageParser.parseViewState(getRes.body);
        this.formIdPlanning = PageParser.parseFormIdPlanning(getRes.body);
    }

    /**
     * Expand the "Scolarité" submenu and return the menuid of the "Mon
     * Planning" entry it lazy-loads. The partial response carries the
     * ViewState the sidebar click has to use.
     */
    private async expandScolarite(menuBody: string): Promise<string> {
        const submenuId = PageParser.parseSidebarSubmenuId(menuBody, SCOLARITE);
        if (!submenuId) {
            log.warn(
                { bytes: menuBody.length },
                "neither « Mon Planning » nor « Scolarité » in the sidebar"
            );
            throw new Error("Menu « Scolarité » non trouvé");
        }

        const ajax = new URLSearchParams({
            "javax.faces.partial.ajax": "true",
            "javax.faces.source": this.formId,
            "javax.faces.partial.execute": this.formId,
            "javax.faces.partial.render": "form:sidebar",
            [this.formId]: this.formId,
            "webscolaapp.Sidebar.ID_SUBMENU": submenuId,
            form: "form",
            "form:largeurDivCenter": "885",
            "form:idInit": this.idInit,
            "form:sauvegarde": "",
            "javax.faces.ViewState": this.viewState,
        }).toString();

        const res = await this.sessionManager.client.post(
            `${this.sessionManager.baseUrl}/faces/MainMenuPage.xhtml`,
            { body: ajax, responseType: "text" }
        );
        this.viewState =
            PageParser.parsePartialViewState(res.body) || this.viewState;

        const menuid = PageParser.parseSidebarMenuId(res.body, MON_PLANNING);
        if (!menuid) {
            log.warn(
                { submenuId, bytes: res.body.length },
                "« Mon Planning » missing from the expanded « Scolarité »"
            );
            log.debug({ snippet: res.body.slice(0, 3000) }, "submenu body");
            throw new Error("« Mon Planning » non trouvé dans « Scolarité »");
        }
        return menuid;
    }

    async postPlan(
        start: number,
        end: number,
        today: string,
        week: string,
        year: string
    ) {
        const postData = new URLSearchParams({
            "javax.faces.partial.ajax": "true",
            "javax.faces.source": this.formIdPlanning,
            "javax.faces.partial.execute": this.formIdPlanning,
            "javax.faces.partial.render": this.formIdPlanning,
            [this.formIdPlanning]: this.formIdPlanning,
            [`${this.formIdPlanning}_start`]: String(start),
            [`${this.formIdPlanning}_end`]: String(end),
            form: "form",
            "form:largeurDivCenter": "",
            "form:idInit": this.idInit,
            "form:date_input": today,
            "form:week": `${week}-${year}`,
            [`${this.formIdPlanning}_view`]: "agendaWeek",
            "form:offsetFuseauNavigateur": "-7200000",
            "form:onglets_activeIndex": "0",
            "form:onglets_scrollState": "0",
            "form:j_idt244_focus": "",
            "form:j_idt244_input": "44323",
            "javax.faces.ViewState": this.viewState,
        }).toString();

        const res = await this.sessionManager.client.post(
            `${this.sessionManager.baseUrl}/faces/Planning.xhtml`,
            {
                body: postData,
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                responseType: "text",
            }
        );

        const updateRegex = new RegExp(
            `<update id="${this.formIdPlanning}"><!\\[CDATA\\[([\\s\\S]*?)]]></update>`
        );
        const match = res.body.match(updateRegex);
        if (!match || !match[1]) {
            log.warn(
                {
                    formIdPlanning: this.formIdPlanning,
                    status: res.statusCode,
                    bytes: res.body.length,
                },
                "planning update missing from Aurion's response"
            );
            log.debug({ snippet: res.body.slice(0, 3000) }, "planning body");
            throw new Error("Planning data not found in response");
        }
        const data = match[1];
        let parsed: { events?: unknown[] };
        try {
            parsed = JSON.parse(data);
        } catch (error) {
            log.warn(
                { snippet: data.slice(0, 500) },
                "planning update is not valid JSON"
            );
            throw error;
        }
        log.info(
            { events: parsed.events?.length ?? 0, start, end },
            "planning fetched"
        );
        return parsed.events;
    }

    async getPlanning(
        email: string,
        password: string,
        start: number,
        end: number
    ) {
        return this.sessionManager.run(email, password, async () => {
            await this.initializeSession();
            await this.postMainSidebar();
            const now = new Date(start);
            const today = now.toLocaleDateString("fr-FR", {
                day: "2-digit",
                month: "2-digit",
                year: "numeric",
            });
            const week = String(getWeekNumber(now)).padStart(2, "0");
            const year = String(now.getFullYear());

            return this.postPlan(start, end, today, week, year);
        });
    }
}

function getWeekNumber(date: Date): number {
    const firstDayOfYear = new Date(date.getFullYear(), 0, 1);
    const pastDaysOfYear =
        (date.getTime() - firstDayOfYear.getTime()) / 86400000;
    return Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
}
