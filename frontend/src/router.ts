import type { RouteRecordRaw } from "vue-router";
import { createRouter, createWebHistory } from "vue-router";
import { userResource } from "@/data/user";
import { session } from "./data/session";

const routes: RouteRecordRaw[] = [
	{
		path: "/",
		name: "Home",
		component: () => import("@/pages/Home.vue"),
	},
	{
		path: "/audio-test",
		name: "AudioTest",
		component: () => import("@/pages/AudioTest.vue"),
		meta: { requiresAdmin: true },
	},
	{
		path: "/:meetingId",
		name: "Meeting",
		component: () => import("@/pages/Meeting.vue"),
		meta: { allowGuest: true },
	},
];

declare const __FRONTEND_ROUTE__: string;

const router = createRouter({
	history: createWebHistory(`${__FRONTEND_ROUTE__}/`),
	routes,
});

function redirectToExternalLogin(nextPath?: string) {
	const loginUrl = `/login${nextPath ? `?redirect-to=${encodeURIComponent(nextPath)}` : ""}`;
	window.location.href = loginUrl;
}

router.beforeEach(async (to, _from, next) => {
	let isLoggedIn = session.isLoggedIn;
	let user: Record<string, unknown> | null = null;
	if (isLoggedIn || to.meta?.requiresAdmin) {
		try {
			if (!userResource.fetched) {
				await userResource.fetch();
			}
			user = userResource.data as Record<string, unknown>;
		} catch (_error) {
			isLoggedIn = false;
		}
	}

	if (to.meta?.requiresAdmin) {
		if (!isLoggedIn) {
			redirectToExternalLogin(to.fullPath);
			return;
		}
		const isAdmin = (user?.roles as string[])?.some((r) =>
			["System Manager", "Administrator"].includes(r),
		);
		if (!isAdmin) {
			return next({ name: "Home" });
		}
	}

	if (to.meta?.allowGuest && to.name === "Meeting") {
		return next();
	}

	if (!isLoggedIn) {
		const nextPath = to.name !== "Home" ? to.fullPath : undefined;
		redirectToExternalLogin(nextPath);
		return;
	}

	next();
});

export default router;
