export function assertPackedDoctorReport(report: {
    status?: unknown;
    checks?: Array<{ name?: unknown; status?: unknown }>;
}): void {
    const problems = (report.checks ?? []).filter((check) => check.status !== "ok");
    const missingClient = problems.filter((check) =>
        check.name === "managed_client_configuration" && check.status === "error");
    const npmWarnings = problems.filter((check) =>
        check.name === "npm_package_access" && check.status === "warning");
    if (
        report.status !== "error"
        || missingClient.length !== 1
        || npmWarnings.length > 1
        || problems.length !== missingClient.length + npmWarnings.length
    ) {
        throw new Error(`Packed doctor reported unexpected problems: ${JSON.stringify(problems)}`);
    }
}
