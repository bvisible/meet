<template>
	<Transition
		enter-active-class="transition-all duration-300 ease-out"
		enter-from-class="opacity-0 transform translate-y-4"
		enter-to-class="opacity-100 transform translate-y-0"
		leave-active-class="transition-all duration-300 ease-in"
		leave-from-class="opacity-100 transform translate-y-0"
		leave-to-class="opacity-0 transform translate-y-4"
	>
		<div
			class="z-5 pointer-events-none w-auto max-w-3xl px-4 md:px-0 bottom-4 left-1/2 transform -translate-x-1/2 absolute"
		>
			<div
				class="flex items-center gap-3 p-4 bg-black/80 backdrop-blur-md rounded-full border border-white/10 shadow-xl pointer-events-auto transition-all duration-300 mx-auto"
			>
				<!-- Microphone -->
				<Button
					@click="$emit('toggle-microphone')"
					variant="solid"
					size="2xl"
					class="!rounded-full p-0 !bg-opacity-90 hover:!bg-opacity-100 transition-all duration-200 hover:scale-105 active:scale-95"
					:class="{
						'!bg-[#e54e17] hover:!bg-[#e54e17]': !isMicOn,
					}"
					:title="`Toggle Audio (${$platform === 'mac' ? '⌘+D' : 'Ctrl+D'})`"
				>
					<template #icon>
						<lucide-mic-off v-if="!isMicOn" class="w-5 h-5 text-white" />
						<lucide-mic v-else class="w-5 h-5 text-white" />
					</template>
				</Button>

				<!-- Camera -->
				<Button
					@click="$emit('toggle-camera')"
					variant="solid"
					theme="gray"
					size="2xl"
					class="!rounded-full p-0 !bg-opacity-90 hover:!bg-opacity-100 transition-all duration-200 hover:scale-105 active:scale-95"
					:class="{
						'!bg-[#e54e17] hover:!bg-[#e54e17]': !isCameraOn,
					}"
					:title="`Toggle Video (${$platform === 'mac' ? '⌘+E' : 'Ctrl+E'})`"
				>
					<template #icon>
						<lucide-video-off v-if="!isCameraOn" class="w-5 h-5 text-white" />
						<lucide-video v-else class="w-5 h-5 text-white" />
					</template>
				</Button>

				<!-- Settings -->
				<Button
					v-if="cameraPermissionGranted || microphonePermissionGranted"
					@click="showSettingsDialog = true"
					variant="solid"
					theme="gray"
					size="2xl"
					class="!rounded-full p-0 !bg-opacity-90 hover:!bg-opacity-100 transition-all duration-200 hover:scale-105 active:scale-95"
					title="Settings"
				>
					<template #icon>
						<lucide-settings class="w-5 h-5 text-white" />
					</template>
				</Button>
			</div>
		</div>
	</Transition>

	<SettingsDialog
		v-model="showSettingsDialog"
		:meetingId="meetingId"
		:isPreview="true"
		@device-changed="$emit('device-changed', $event)"
	/>
</template>

<script setup lang="ts">
import { Button } from "frappe-ui";
import SettingsDialog from "./settings/SettingsDialog.vue";

defineProps({
	isMicOn: {
		type: Boolean,
		required: true,
	},
	isCameraOn: {
		type: Boolean,
		required: true,
	},
	meetingId: {
		type: String,
		default: "",
	},
	cameraPermissionGranted: {
		type: Boolean,
		default: false,
	},
	microphonePermissionGranted: {
		type: Boolean,
		default: false,
	},
});

defineEmits(["toggle-microphone", "toggle-camera", "device-changed"]);

const showSettingsDialog = defineModel({
	type: Boolean,
	default: false,
});
</script>
