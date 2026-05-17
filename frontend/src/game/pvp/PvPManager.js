import { io } from 'socket.io-client';
import { usePvPStore } from '../../store/pvpStore';
import { useGameStore } from '../../store/gameStore';

const SOCKET_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

class PvPManager {
    constructor() {
        this.socket = null;
        this.currentRoom = null;
    }

    connect() {
        if (this.socket) return;
        
        this.socket = io(SOCKET_URL);
        
        this.socket.on('connect', () => {
            console.log('[PvP] Connected to socket server');
        });

        this.socket.on('room_updated', (data) => {
            usePvPStore.getState().setPlayers(data.players);
            usePvPStore.getState().setIsHost(this.socket.id === data.hostId);
        });

        this.socket.on('match_starting', (data) => {
            console.log('[PvP] Match starting with data:', data);
            if (data && data.lootManifest) {
                usePvPStore.getState().setLootManifest(data.lootManifest);
            }
            usePvPStore.getState().setIsMatchStarted(true);
        });

        this.socket.on('countdown_tick', (tick) => {
            // Forward to the active scene if needed or update store
            if (this.lobbyScene && this.lobbyScene.updateCountdown) {
                this.lobbyScene.updateCountdown(tick);
            }
        });

        this.socket.on('timer_update', (time) => {
            usePvPStore.getState().setMatchTime(time);
        });

        this.socket.on('leaderboard_update', (data) => {
            usePvPStore.getState().setLeaderboard(Object.values(data));
        });

        this.socket.on('match_ended', (data) => {
            usePvPStore.getState().setLeaderboard(Object.values(data));
            usePvPStore.getState().setIsMatchStarted(false);
        });

        this.socket.on('loot_removed', (data) => {
            if (this.gameScene && this.gameScene.removeLootLocally) {
                this.gameScene.removeLootLocally(data.pointIndex);
            }
        });

        this.socket.on('respawn_loot', (data) => {
            if (this.gameScene && this.gameScene.respawnLootLocally) {
                this.gameScene.respawnLootLocally(data.pointIndex, data.weaponKey);
            }
        });

        this.socket.on('player_event', (event) => {
            // Forward movement/combat events to the active PvPGame scene
            if (this.gameScene) {
                this.gameScene.handleNetworkEvent(event);
            }
        });
    }

    createRoom() {
        const appearance = useGameStore.getState().appearance;
        const name = useGameStore.getState().userProfile?.username || 'Soldier';
        
        this.socket.emit('create_room', { name, appearance }, (response) => {
            if (response.success) {
                usePvPStore.getState().setRoomCode(response.code);
                this.currentRoom = response.code;
            }
        });
    }

    joinRoom(code) {
        const appearance = useGameStore.getState().appearance;
        const name = useGameStore.getState().userProfile?.username || 'Soldier';

        this.socket.emit('join_room', { code, name, appearance }, (response) => {
            if (response.success) {
                usePvPStore.getState().setRoomCode(code);
                this.currentRoom = code;
            } else {
                alert(response.message || "Could not join room");
            }
        });
    }

    toggleReady(isReady) {
        this.socket.emit('set_ready', { code: this.currentRoom, isReady });
    }

    sendPlayerUpdate(data) {
        if (this.socket && this.currentRoom) {
            this.socket.emit('player_update', { code: this.currentRoom, ...data });
        }
    }

    disconnect() {
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
        }
        usePvPStore.getState().resetPvP();
    }
}

export default new PvPManager();
