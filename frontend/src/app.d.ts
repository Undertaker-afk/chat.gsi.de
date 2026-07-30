import type { User } from '$lib/server/session';

declare global {
	namespace App {
		interface Locals {
			user?: User;
		}
	}
}

export {};
