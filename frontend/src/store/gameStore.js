import { create } from 'zustand';
const getApiUrl = () => {
    const envUrl = import.meta.env.VITE_API_URL;
    if (envUrl && !envUrl.includes('localhost') && !envUrl.includes('127.0.0.1')) {
        return envUrl;
    }
    if (typeof window !== 'undefined' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
        return window.location.origin;
    }
    return 'http://localhost:5000';
};
const API_BASE = getApiUrl();

export const useGameStore = create((set) => ({
    playerHealth: 100,
    playerFuel: 100,
    ammo: { loaded: 0, reserve: 0 },
    zoomLevel: 1,
    isMobile: false,
    isGuest: false,
    grenades: 3,
    godMode: false,

    // Character Customization
    appearance: {
        head: 'Commando',
        torso: 'Commando',
        legs: 'Commando',
        arms: 'commando'
    },
    userToken: null,
    userProfile: null,
    isGuest: false,

    // Flow State
    isNewGame: false,
    selectedWeapons: ['pistol', null], // Default starting loadout
    hasProgress: false,
    totalKills: Number(localStorage.getItem('sd_guest_total_kills') || 0),
    highestWave: Number(localStorage.getItem('sd_guest_wave') || 0),
    setHasProgress: (val) => {
        set({ hasProgress: val });
        const { isGuest } = useGameStore.getState();
        if (isGuest) {
            localStorage.setItem('sd_guest_progress', val);
        }
    },

    setPlayerHealth: (health) => set({ playerHealth: health }),
    setPlayerFuel: (fuel) => set({ playerFuel: fuel }),
    setAmmo: (loaded, reserve) => set({ ammo: { loaded, reserve } }),
    setZoomLevel: (zoom) => set({ zoomLevel: zoom }),
    setIsMobile: (isMobile) => set({ isMobile }),
    setGrenades: (count) => set({ grenades: count }),
    setGodMode: (val) => set({ godMode: val }),

    setIsNewGame: (val) => set({ isNewGame: val }),
    showHUD: false,
    setShowHUD: (val) => set({ showHUD: val }),

    setSelectedWeapons: async (weapons) => {
        set({ selectedWeapons: weapons });
        const { userToken, userProfile } = useGameStore.getState();
        if (userToken) {
            // Update local cache
            if (userProfile) {
                userProfile.selectedWeapons = weapons;
                localStorage.setItem('sd_profile', JSON.stringify(userProfile));
            }
            try {
                await fetch(`${API_BASE}/api/score/armory`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', 'x-auth-token': userToken },
                    body: JSON.stringify({ selectedWeapons: weapons })
                });
            } catch (e) { console.error("Sync error", e); }
        }
    },

    setAppearance: async (parts) => {
        set((state) => ({ appearance: { ...state.appearance, ...parts } }));
        const { userToken, appearance, userProfile } = useGameStore.getState();
        if (userToken) {
            // Update local cache
            if (userProfile) {
                userProfile.appearance = appearance;
                localStorage.setItem('sd_profile', JSON.stringify(userProfile));
            }
            try {
                await fetch(`${API_BASE}/api/score/armory`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', 'x-auth-token': userToken },
                    body: JSON.stringify({ appearance })
                });
            } catch (e) { console.error("Sync error", e); }
        }
    },

    login: (token, profile) => {
        console.log("[Login] User profile:", profile);
        const defaultAppearance = { head: 'Commando', torso: 'Commando', legs: 'Commando', arms: 'commando' };
        const defaultWeapons = ['pistol', null];

        // Ensure profile data is valid and has expected structure
        const appearance = (profile?.appearance && profile.appearance.head) ? profile.appearance : defaultAppearance;
        const weapons = (profile?.selectedWeapons && Array.isArray(profile.selectedWeapons) && profile.selectedWeapons.length > 0) ? profile.selectedWeapons : defaultWeapons;
        const highestWave = profile?.highestWave || 0;
        const totalKills = profile?.totalKills || 0;

        const isGuest = !token;
        if (token) localStorage.setItem('sd_token', token);
        if (profile) localStorage.setItem('sd_profile', JSON.stringify(profile));
        localStorage.setItem('sd_is_guest', isGuest);

        set({
            userToken: token,
            userProfile: profile,
            isGuest: isGuest,
            appearance: appearance,
            selectedWeapons: weapons,
            highestWave: highestWave,
            totalKills: totalKills,
            hasProgress: token ? (highestWave > 0) : (localStorage.getItem('sd_guest_progress') === 'true')
        });

        // If Guest, load their local stats immediately
        if (isGuest) {
            set({
                totalKills: Number(localStorage.getItem('sd_guest_total_kills') || 0),
                highestWave: Number(localStorage.getItem('sd_guest_wave') || 0)
            });
        }
    },

    logout: () => {
        localStorage.removeItem('sd_token');
        localStorage.removeItem('sd_profile');
        localStorage.removeItem('sd_is_guest');
        set({
            userToken: null,
            userProfile: null,
            isGuest: false,
            appearance: { head: 'Commando', torso: 'Commando', legs: 'Commando', arms: 'commando' },
            selectedWeapons: ['pistol', null],
            hasProgress: false,
            totalKills: 0,
            highestWave: 0
        });
    },

    updateStats: async (killsDelta, wave) => {
        const { userToken, isGuest, totalKills, highestWave } = useGameStore.getState();
        
        // Cumulative Score
        const newTotalKills = totalKills + killsDelta;
        const newWave = Math.max(highestWave, wave);
        
        console.log(`[Stats Update] Career Kills: ${newTotalKills}, Max Wave: ${newWave}`);
        set({ totalKills: newTotalKills, highestWave: newWave, hasProgress: true });

        if (isGuest) {
            localStorage.setItem('sd_guest_progress', 'true');
            localStorage.setItem('sd_guest_total_kills', newTotalKills);
            localStorage.setItem('sd_guest_wave', newWave);
        } else if (userToken) {
            // Update local cache
            const { userProfile } = useGameStore.getState();
            if (userProfile) {
                userProfile.totalKills = newTotalKills;
                userProfile.highestWave = newWave;
                localStorage.setItem('sd_profile', JSON.stringify(userProfile));
            }
            try {
                await fetch(`${API_BASE}/api/score/update`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-auth-token': userToken },
                    body: JSON.stringify({ killsDelta: killsDelta, highestWave: newWave })
                });
            } catch (e) { console.error("Score sync failed", e); }
        }
    },

    fetchRecord: async () => {
        const { userToken } = useGameStore.getState();
        if (!userToken) return;
        try {
            const res = await fetch(`${API_BASE}/api/score/record`, {
                headers: { 'x-auth-token': userToken }
            });
            const data = await res.json();
            if (res.ok) {
                set({ totalKills: data.totalKills, highestWave: data.highestWave });
            }
        } catch (e) { console.error("Record fetch failed", e); }
    }
}));
