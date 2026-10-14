// //// Neoffice — added file (no upstream equivalent)
// Séance note-taking: shows the SFU's MediasoupManager to the séance module
// through the small MediaFacade interface (which is also what the tests fake).

import type { MediasoupManager } from '../mediasoup/MediasoupManager';
import type { MediaFacade, ProducerLike, RouterLike } from './SeanceManager';

export function mediaFacadeOf(manager: MediasoupManager): MediaFacade {
	return {
		getRouter: (roomId) =>
			manager.getRouter(roomId) as unknown as RouterLike | undefined,
		getPeerAudioProducers: (roomId, peerId) =>
			manager.getPeerAudioProducers(
				roomId,
				peerId,
			) as unknown as ProducerLike[],
		onProducerCreated: (listener) =>
			manager.onProducerCreated(
				listener as unknown as Parameters<
					MediasoupManager['onProducerCreated']
				>[0],
			),
		onPeerRemoved: (listener) => manager.onPeerRemoved(listener),
		onRoomClosed: (listener) => manager.onRoomClosed(listener),
	};
}
