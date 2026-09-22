import assert from "node:assert/strict";
import test from "node:test";
import type {
    PublicationLease,
    PublicationPackageOwnership,
} from "@zokizuan/satori-core";
import { NavigationHandlers } from "./navigation-handlers.js";

type NavigationHandlersHost = ConstructorParameters<typeof NavigationHandlers>[0];
type PreparedNavigationState = Awaited<ReturnType<NavigationHandlersHost["prepareNavigationRead"]>>;

function fakeLease(): PublicationLease {
    return {
        id: "publication-1",
        publication: {
            id: "publication-1",
            canonicalRoot: "/repo",
        },
        release: () => undefined,
    } as unknown as PublicationLease;
}

function readyState(): PreparedNavigationState {
    return {
        state: "ready",
        root: {
            path: "/repo",
            info: { status: "indexed" },
        },
        publication: {
            id: "publication-1",
        },
    } as unknown as PreparedNavigationState;
}

function parseResponse(response: Awaited<ReturnType<NavigationHandlers["handleArchitectureOverview"]>>) {
    return JSON.parse(response.content[0]!.text) as {
        status: string;
        reason?: string;
        path?: string;
        message?: string;
    };
}

test("architecture overview loads package ownership from the exact leased Publication and fails closed when missing", async () => {
    const lease = fakeLease();
    let released = false;
    let ownershipPublication: PublicationLease | undefined;
    lease.release = () => {
        released = true;
    };

    const handler = new NavigationHandlers({
        prepareNavigationRead: async () => readyState(),
        acquirePublicationLease: () => lease,
        isPublicationAdmitted: async () => true,
        getPublicationNavigationStatus: async () => "valid",
        getPublicationPackageOwnership: (publication: PublicationLease) => {
            ownershipPublication = publication;
            return null;
        },
        stringifyToolJson: JSON.stringify,
    } as unknown as NavigationHandlersHost);

    const response = await handler.handleArchitectureOverview({
        path: "/repo",
        scope: "all",
        limit: 10,
    });

    assert.equal(ownershipPublication, lease);
    assert.equal(released, true);
    assert.deepEqual(parseResponse(response), {
        status: "not_ready",
        reason: "missing_package_ownership",
        path: "/repo",
        message: "The leased Publication is missing its package ownership snapshot.",
    });
});

test("architecture overview fails closed on package ownership from a mismatched Publication root", async () => {
    const lease = fakeLease();
    const ownership = {
        schemaVersion: "package_ownership_v1",
        canonicalRoot: "/different-repo",
        workspace: null,
        packages: [],
        files: [],
        controlFiles: [],
    } as PublicationPackageOwnership;

    const handler = new NavigationHandlers({
        prepareNavigationRead: async () => readyState(),
        acquirePublicationLease: () => lease,
        isPublicationAdmitted: async () => true,
        getPublicationNavigationStatus: async () => "valid",
        getPublicationPackageOwnership: () => ownership,
        stringifyToolJson: JSON.stringify,
    } as unknown as NavigationHandlersHost);

    const response = await handler.handleArchitectureOverview({
        path: "/repo",
        scope: "runtime",
        limit: 10,
    });

    assert.deepEqual(parseResponse(response), {
        status: "not_ready",
        reason: "incompatible_package_ownership",
        path: "/repo",
        message: "The leased Publication package ownership root is incompatible.",
    });
});
