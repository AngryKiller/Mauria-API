export interface IdRequest {
    email: string;
    password: string;
}

/** Credentials plus the Aurion instance of the user's school. */
export interface SchoolRequest extends IdRequest {
    /** Root URL of the school's Aurion; DEFAULT_AURION_URL when omitted. */
    baseUrl?: string;
}

export interface PlanningRequest extends SchoolRequest {
    startTimestamp: number;
    endTimestamp: number;
}
