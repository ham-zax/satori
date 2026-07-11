import { fixtureOwner } from "./owner";

export function fixtureCaller(): string {
    return fixtureOwner();
}
