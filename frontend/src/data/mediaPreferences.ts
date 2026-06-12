import { type Ref, ref } from "vue";

function getLocalStorage(): Storage | null {
	if (
		typeof localStorage === "undefined" ||
		typeof localStorage.getItem !== "function" ||
		typeof localStorage.setItem !== "function"
	) {
		return null;
	}
	return localStorage;
}

function readBool(key: string, def = true): boolean {
	const v = getLocalStorage()?.getItem(key) ?? null;
	if (v === null) return def;
	return v === "1";
}

function readString(key: string, def = ""): string {
	const v = getLocalStorage()?.getItem(key) ?? null;
	return v !== null ? v : def;
}

function writeString(key: string, value: string): void {
	getLocalStorage()?.setItem(key, value);
}

export const micEnabled: Ref<boolean> = ref(readBool("mediaPref.mic", false));
export const cameraEnabled: Ref<boolean> = ref(
	readBool("mediaPref.camera", false),
);
export const selectedCameraId: Ref<string> = ref(
	readString("mediaPref.cameraId", ""),
);
export const selectedMicId: Ref<string> = ref(
	readString("mediaPref.micId", ""),
);
export const selectedSpeakerId: Ref<string> = ref(
	readString("mediaPref.speakerId", ""),
);
export const noiseCancellationEnabled: Ref<boolean> = ref(
	readBool("mediaPref.noiseCancellation", false),
);

export const pushToTalkEnabled: Ref<boolean> = ref(
	readBool("mediaPref.pushToTalk", false),
);

export const autoHideToolbar: Ref<boolean> = ref(
	readBool("mediaPref.autoHideToolbar", false),
);

export function setNoiseCancellationEnabled(val: boolean): void {
	noiseCancellationEnabled.value = !!val;
	writeString(
		"mediaPref.noiseCancellation",
		noiseCancellationEnabled.value ? "1" : "0",
	);
}

export function setPushToTalkEnabled(val: boolean): void {
	pushToTalkEnabled.value = !!val;
	writeString(
		"mediaPref.pushToTalk",
		pushToTalkEnabled.value ? "1" : "0",
	);
}

export function setAutoHideToolbar(val: boolean): void {
	autoHideToolbar.value = !!val;
	writeString(
		"mediaPref.autoHideToolbar",
		autoHideToolbar.value ? "1" : "0",
	);
}

export function setMicEnabled(val: boolean): void {
	micEnabled.value = !!val;
	writeString("mediaPref.mic", micEnabled.value ? "1" : "0");
}

export function setCameraEnabled(val: boolean): void {
	cameraEnabled.value = !!val;
	writeString("mediaPref.camera", cameraEnabled.value ? "1" : "0");
}

export function setSelectedCameraId(deviceId: string): void {
	selectedCameraId.value = deviceId || "";
	writeString("mediaPref.cameraId", selectedCameraId.value);
}

export function setSelectedMicId(deviceId: string): void {
	selectedMicId.value = deviceId || "";
	writeString("mediaPref.micId", selectedMicId.value);
}

export function setSelectedSpeakerId(deviceId: string): void {
	selectedSpeakerId.value = deviceId || "";
	writeString("mediaPref.speakerId", selectedSpeakerId.value);
}

export function loadMediaPreferences(): void {
	micEnabled.value = readBool("mediaPref.mic", true);
	cameraEnabled.value = readBool("mediaPref.camera", true);
	selectedCameraId.value = readString("mediaPref.cameraId", "");
	selectedSpeakerId.value = readString("mediaPref.speakerId", "");
	selectedMicId.value = readString("mediaPref.micId", "");
	noiseCancellationEnabled.value = readBool(
		"mediaPref.noiseCancellation",
		false,
	);
	pushToTalkEnabled.value = readBool("mediaPref.pushToTalk", false);
	autoHideToolbar.value = readBool("mediaPref.autoHideToolbar", false);
}
