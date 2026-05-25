import Phaser from 'phaser';
import Player from '../entities/Player';
import NetworkPlayer from './NetworkPlayer';
import PvPManager from './PvPManager';
import { usePvPStore } from '../../store/pvpStore';
import { useGameStore } from '../../store/gameStore';

export default class PvPGame extends Phaser.Scene {
    constructor() {
        super('PvPGame');
    }

    create() {
        const { width, height } = this.cameras.main;
        const pvpStore = usePvPStore.getState();
        const store = useGameStore.getState();

        // Generate placeholder textures (For particles, jetpack, and blood)
        const g = this.make.graphics({ x: 0, y: 0, add: false });
        g.fillStyle(0xFFFF00); g.fillRect(0, 0, 8, 8); g.generateTexture('bullet_player', 8, 8);
        g.clear();
        g.fillStyle(0xFF4400); g.fillRect(0, 0, 8, 8); g.generateTexture('bullet_enemy', 8, 8);
        g.clear();
        g.fillStyle(0xFFFFFF); g.fillRect(0, 0, 32, 32); g.generateTexture('white_square', 32, 32);
        g.clear();
        g.fillStyle(0xFF8800); g.fillRect(0, 0, 10, 10); g.generateTexture('explosion_part', 10, 10);

        // 1. Tiled Map Integration (USE THE MASTER MAP)
        const map = this.make.tilemap({ key: 'map' });
        const bgTileset = map.addTilesetImage('background', 'tileset_background');
        const mainTileset = map.addTilesetImage('tileset_70', 'tileset_70', 70, 70, 0, 2);

        this.backgroundLayer = map.createLayer('Background_Walls', bgTileset, 0, 0);
        this.backgroundDetailsLayer = map.createLayer('Background_Details', bgTileset, 0, 0);
        this.platformLayer = map.createLayer('Platforms', [bgTileset, mainTileset], 0, 0);
        this.bushesLayer = map.createLayer('Foreground_Bushes', [bgTileset, mainTileset], 0, 0).setDepth(10);
        this.overlayLayer = map.createLayer('Overlay', [bgTileset, mainTileset], 0, 0).setDepth(20);
        
        this.platformLayer.setCollisionByProperty({ collides: true });
        this.platformLayer.setCollisionByExclusion([-1]);
        this.platforms = this.platformLayer;

        // Physics Details (Object Layer for curved edges)
        this.physicsDetails = this.physics.add.staticGroup();
        const details = map.createFromObjects('Physics_Details', { name: '', key: 'background' });
        details.forEach(detail => {
            detail.setDepth(5);
            detail.setVisible(false);
            this.physicsDetails.add(detail);
        });

        this.worldWidth = map.widthInPixels;
        this.worldHeight = map.heightInPixels;
        this.physics.world.setBounds(0, 0, this.worldWidth, this.worldHeight);
        this.cameras.main.setBounds(0, 0, this.worldWidth, this.worldHeight);

        // Zoom Setup
        this.currentZoomIndex = 0;
        this.uiZoomLevels = [1];
        this.lastActiveWeapon = 'pistol';
        this.updateBaseZoom();
        this.applyCurrentZoom();

        // Re-calculate on window resize
        this.scale.on('resize', () => {
            this.updateBaseZoom();
            this.applyCurrentZoom();
        });

        this.input.keyboard.on('keydown-Z', () => this.toggleZoom());
        this.input.keyboard.on('keydown-ESC', () => this.toggleEscMenu());
        this.remoteGrenades = new Map();

        // 2. Physics Groups (Identical to Solo)
        this.weaponPickups = this.physics.add.group();
        this.enemies = this.physics.add.group(); // This will hold Network Players
        this.enemyBullets = this.physics.add.group({ classType: Phaser.Physics.Arcade.Image, runChildUpdate: true });

        // 3. Spawn Local Player
        const myIndex = pvpStore.players.findIndex(p => p.id === PvPManager.socket.id);
        const spawnObjects = map.getObjectLayer('Spawns_And_Pickups')?.objects || [];
        const playerSpawns = spawnObjects.filter(obj => obj.name === 'player_spawn');
        
        const mySpawn = playerSpawns[myIndex % playerSpawns.length] || { x: 500, y: 500 };
        this.player = new Player(this, mySpawn.x, mySpawn.y);
        
        // GIVE DEFAULT LOADOUT (Just like Solo)
        this.player.weapons.resetInventory();
        this.player.weapons.addWeapon('pistol');
        this.player.weapons.addWeapon('dagger');
        
        // Match Solo Collision
        this.physics.add.collider(this.player.sprite, [this.platforms, this.physicsDetails]);
        this.cameras.main.startFollow(this.player.sprite, true, 0.1, 0.1);

        // 4. Spawn Remote Players (Into the 'enemies' group)
        this.networkPlayers = new Map();
        pvpStore.players.forEach((p, index) => {
            if (p.id !== PvPManager.socket.id) {
                const theirSpawn = playerSpawns[index % playerSpawns.length] || { x: 600, y: 500 };
                const np = new NetworkPlayer(this, p, theirSpawn.x, theirSpawn.y);
                this.enemies.add(np.container); // ADD TO ENEMIES GROUP FOR COLLISION
                this.networkPlayers.set(p.id, np);
            }
        });

        // 5. Initial Loots
        this.lootPoints = [];
        spawnObjects.forEach(obj => {
            if (obj.name === 'loot_drop') {
                const point = { x: obj.x, y: obj.y, active: false, index: this.lootPoints.length };
                this.lootPoints.push(point);
                this.spawnNewLootAtPoint(point);
            }
        });

        // 6. Collision & Overlap Logic (PVP VERSION)
        // REMOVED collider for this.enemies with platforms to prevent kinematic friction/shaking!
        this.physics.add.collider(this.weaponPickups, [this.platforms, this.physicsDetails]);

        this.physics.add.collider(this.player.weapons.bullets, [this.platforms, this.physicsDetails], (b) => {
            if (b.isRocket) b.onImpact(); else b.destroy();
        });

        // Hit registration: When local bullet hits a remote player (enemy)
        this.physics.add.overlap(this.player.weapons.bullets, this.enemies, this.bulletHitEnemy, null, this);

        // 7. UI & Networking
        PvPManager.gameScene = this;
        store.setShowHUD(true);
        this.matchText = this.add.text(width / 2, 20, '5:00', { font: 'bold 24px monospace', fill: '#ffffff' })
            .setOrigin(0.5).setDepth(100);

        this.unsubscribe = usePvPStore.subscribe((state) => {
            if (!state.isMatchStarted && state.leaderboard.length > 0) this.showResults(state.leaderboard);
            
            // Handle Network Player Reconnections/Dummies
            if (this.networkPlayers) {
                state.players.forEach(p => {
                    if (p.id !== PvPManager.socket.id) {
                        const existingNpArray = Array.from(this.networkPlayers.values());
                        const np = existingNpArray.find(n => n.name === p.name);
                        if (np) {
                            // Update ID if they reconnected with a new socket
                            if (np.id !== p.id) {
                                this.networkPlayers.delete(np.id);
                                np.id = p.id;
                                this.networkPlayers.set(p.id, np);
                            }
                            // Update dummy state
                            if (np.disconnected !== p.disconnected) {
                                np.disconnected = p.disconnected;
                                if (p.disconnected) {
                                    np.visual.setExpression('dead'); // Visual indicator
                                } else {
                                    np.visual.setExpression('focus');
                                }
                            }
                        }
                    }
                });
            }
        });

        // Event for Network Bullets (Visual Only)
        this.player.weapons.onFire = (data) => PvPManager.sendPlayerUpdate({ event: 'fire', ...data });
        
        // Event for Network Melee Hits (Melee Damage)
        this.player.weapons.onMeleeHit = (data) => PvPManager.sendPlayerUpdate({ event: 'hit', targetId: data.id, damage: data.damage });

        // Event for Network Reloads
        this.player.weapons.onReload = () => PvPManager.sendPlayerUpdate({ event: 'reload' });
        // Event for Network Explosions
        this.onExplosion = (data) => PvPManager.sendPlayerUpdate({ event: 'explosion', ...data });
        
        // Event for Network Grenades
        this.onGrenade = (data) => PvPManager.sendPlayerUpdate({ event: 'grenade', ...data });
        this.onGrenadeSync = (data) => PvPManager.sendPlayerUpdate({ event: 'grenade_sync', ...data });

        // Cleanup on scene shutdown
        this.events.on('shutdown', () => {
            this.hideEscMenu();
            if (this.unsubscribe) this.unsubscribe();
        });
    }

    spawnNewLootAtPoint(point) {
        const manifest = usePvPStore.getState().lootManifest;
        // Use the point's index to pick a consistent weapon from the manifest
        const weaponKey = manifest[point.index % manifest.length] || 'pistol';
        this.spawnWeaponPickup(point.x, point.y, weaponKey, null, true, point.index);
        point.active = true;
    }

    spawnWeaponPickup(x, y, weaponKey, ammo = null, isPermanent = false, pointIndex = -1, isLocal = true, lootId = null, syncedVx = null) {
        const pickup = this.weaponPickups.create(x, y, weaponKey);
        pickup.weaponKey = weaponKey;
        pickup.isPermanent = isPermanent;
        pickup.pointIndex = pointIndex;
        pickup.ammo = ammo; // SAVE AMMO STATE
        
        // Use provided lootId or generate a unique one
        pickup.lootId = lootId || (pointIndex !== -1 ? `map_${pointIndex}` : `drop_${Date.now()}_${Math.random()}`);
        
        if (weaponKey === 'grenade') {
            pickup.setDisplaySize(25, 25);
            pickup.body.setSize(20, 20);
        } else if (weaponKey === 'medkit') {
            pickup.setDisplaySize(75, 40);
            pickup.body.setSize(40, 20);
        } else {
            pickup.setDisplaySize(60, 30);
            pickup.body.setSize(40, 20);
        }
        
        pickup.body.setBounce(0.5).setDrag(100);

        if (!isPermanent) {
            const vx = syncedVx !== null ? syncedVx : Phaser.Math.Between(-150, 150);
            pickup.body.setVelocity(vx, -200);
            this.time.delayedCall(15000, () => { if (pickup.active) pickup.destroy(); });
            
            // BROADCAST manual drops with same ID, Velocity, and AMMO
            if (pointIndex === -1 && isLocal) {
                PvPManager.sendPlayerUpdate({ 
                    event: 'spawn_loot', 
                    x, y, weaponKey, ammo, 
                    lootId: pickup.lootId,
                    vx: vx 
                });
            }
        } else {
            pickup.body.setImmovable(true);
            pickup.body.setAllowGravity(false);
        }
        return pickup;
    }

    notifyPickup(lootId) {
        if (lootId) {
            PvPManager.sendPlayerUpdate({ event: 'despawn_loot', lootId });
        }
    }

    bulletHitEnemy(bullet, enemyContainer) {
        const np = Array.from(this.networkPlayers.values()).find(p => p.container === enemyContainer);
        if (!np || !bullet.active) return;

        if (bullet.isRocket) { bullet.onImpact(); return; }
        
        // Local screen effect
        const particles = this.add.particles(bullet.x, bullet.y, 'explosion_part', {
            speed: 100, lifespan: 200, scale: { start: 0.5, end: 0 }, quantity: 5
        });
        this.time.delayedCall(200, () => particles.destroy());

        // Notify server of hit
        PvPManager.sendPlayerUpdate({ event: 'hit', targetId: np.id, damage: bullet.damage || 15 });
        bullet.destroy();
    }

    update(time, delta) {
        if (!this.player) return;
        const pointer = this.input.activePointer;
        const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
        
        this.player.update(time, delta, pointer);

        // Track weapon change for zoom levels
        const currentWeapon = this.player.weapons.inventory[this.player.weapons.currentSlot] || 'dagger';
        if (currentWeapon !== this.lastActiveWeapon) {
            this.lastActiveWeapon = currentWeapon;
            this.onWeaponChanged(currentWeapon);
        }

        // Network Throttling (Send 20 times a second instead of 60)
        if (!this.lastNetworkUpdate) this.lastNetworkUpdate = 0;
        
        if (time > this.lastNetworkUpdate + 50) {
            this.lastNetworkUpdate = time;
            const aimAngle = Phaser.Math.Angle.Between(this.player.sprite.x, this.player.sprite.y, worldPoint.x, worldPoint.y);
            
            // Filter velocities to prevent dead-reckoning prediction shaking/drifts
            const isOnGround = this.player.sprite.body.touching.down || this.player.sprite.body.blocked.down;
            const isBlockedHorizontal = this.player.sprite.body.blocked.left || this.player.sprite.body.blocked.right;
            const vx = isBlockedHorizontal ? 0 : this.player.sprite.body.velocity.x;
            const vy = isOnGround ? 0 : this.player.sprite.body.velocity.y;

            // Send state to server
            PvPManager.sendPlayerUpdate({
                x: Math.round(this.player.sprite.x),
                y: Math.round(this.player.sprite.y),
                vx: vx,
                vy: vy,
                aimAngle: aimAngle,
                isCrouching: this.player.isCrouching,
                weapon: this.player.weapons.inventory[this.player.weapons.currentSlot],
                isDead: this.player.isRespawning, // Broadcast local respawn state
                timestamp: Date.now() // For out-of-order packet dropping
            });
        }

        // Update Remote Players
        this.networkPlayers.forEach(np => np.update(time, delta));

        // Timer
        const matchTime = usePvPStore.getState().matchTime;
        const mins = Math.floor(matchTime / 60);
        const secs = matchTime % 60;
        this.matchText.setText(`${mins}:${secs.toString().padStart(2, '0')}`);

        // Keep timer perfectly at the top-middle of the screen regardless of camera zoom/scroll
        if (this.matchText && this.cameras && this.cameras.main) {
            const cam = this.cameras.main;
            const zoom = cam.zoom || 1;
            this.matchText.setScale(1 / zoom);
            const viewWidth = cam.worldView.width || this.scale.width;
            this.matchText.setPosition(
                cam.worldView.x + viewWidth / 2,
                cam.worldView.y + (20 / zoom)
            );
        }
    }

    updateBaseZoom() {
        const widthZoom = this.scale.width / this.worldWidth;
        const heightZoom = this.scale.height / this.worldHeight;
        this.baseZoom = Math.max(widthZoom, heightZoom);
    }

    applyCurrentZoom(instant = true) {
        const uiLabel = this.uiZoomLevels[this.currentZoomIndex] || 1;
        const targetZoom = this.baseZoom * (4 / uiLabel);
        if (instant) {
            this.cameras.main.setZoom(targetZoom);
        } else {
            this.cameras.main.zoomTo(targetZoom, 300, 'Power2');
        }
    }

    toggleZoom() {
        if (this.uiZoomLevels.length <= 1) return;
        
        this.currentZoomIndex++;
        if (this.currentZoomIndex >= this.uiZoomLevels.length) this.currentZoomIndex = 0;
        const uiLabel = this.uiZoomLevels[this.currentZoomIndex];
        useGameStore.getState().setZoomLevel(uiLabel);
        this.applyCurrentZoom(false);
    }

    getZoomLevelsForWeapon(weaponKey) {
        if (!weaponKey) return [1];
        const key = weaponKey.toLowerCase();
        if (['pistol', 'dagger', 'shotgun', 'tacticalshotgun'].includes(key)) {
            return [1];
        }
        if (['smg', 'rifle', 'machinegun'].includes(key)) {
            return [1, 2];
        }
        if (['sniper', 'launcher'].includes(key)) {
            return [1, 2, 4];
        }
        return [1];
    }

    onWeaponChanged(weaponKey) {
        const levels = this.getZoomLevelsForWeapon(weaponKey);
        const currentLevel = this.currentZoomIndex < this.uiZoomLevels.length ? this.uiZoomLevels[this.currentZoomIndex] : 1;
        this.uiZoomLevels = levels;
        
        const newIndex = levels.indexOf(currentLevel);
        if (newIndex !== -1) {
            this.currentZoomIndex = newIndex;
        } else {
            this.currentZoomIndex = 0; // Reset to 1x
        }
        this.applyCurrentZoom(false);
        useGameStore.getState().setZoomLevel(this.uiZoomLevels[this.currentZoomIndex]);
    }

    toggleEscMenu() {
        let menu = document.getElementById('pvp-esc-menu');
        if (menu && menu.style.display === 'flex') {
            this.hideEscMenu();
        } else {
            this.showEscMenu();
        }
    }

    showEscMenu() {
        let menu = document.getElementById('pvp-esc-menu');
        if (!menu) {
            menu = document.createElement('div');
            menu.id = 'pvp-esc-menu';
            menu.style.cssText = `
                position: fixed; top: 0; left: 0; width: 100%; height: 100%;
                background: rgba(0,0,0,0.85); display: flex; flex-direction: column;
                justify-content: center; align-items: center; z-index: 9999;
                font-family: 'Orbitron', sans-serif; color: white;
            `;
            menu.innerHTML = `
                <h1 style="font-size: 3rem; margin-bottom: 0.5rem; color: #f43f5e; text-shadow: 0 0 20px rgba(244,63,94,0.6);">MATCH IN PROGRESS</h1>
                <p style="font-size: 1rem; margin-bottom: 2rem; color: #94a3b8;">The battle continues in the background...</p>
                <button id="pvp-resume-btn" style="padding: 1rem 3rem; margin: 0.5rem; background: #111; border: 2px solid #22d3ee; color: #22d3ee; cursor: pointer; font-size: 1.2rem; width: 250px; font-weight: bold; transition: 0.2s;">RESUME</button>
                <button id="pvp-menu-btn" style="padding: 1rem 3rem; margin: 0.5rem; background: #111; border: 2px solid #f43f5e; color: #f43f5e; cursor: pointer; font-size: 1.2rem; width: 250px; font-weight: bold; transition: 0.2s;">EXIT TO MENU</button>
            `;
            document.body.appendChild(menu);

            document.getElementById('pvp-resume-btn').onclick = () => this.hideEscMenu();
            document.getElementById('pvp-menu-btn').onclick = () => {
                this.hideEscMenu();
                PvPManager.disconnect();
                this.scene.start('MainMenu');
            };
            
            // Add hover effects
            const resBtn = document.getElementById('pvp-resume-btn');
            resBtn.onmouseenter = () => { resBtn.style.background = '#22d3ee'; resBtn.style.color = '#000'; };
            resBtn.onmouseleave = () => { resBtn.style.background = '#111'; resBtn.style.color = '#22d3ee'; };

            const menBtn = document.getElementById('pvp-menu-btn');
            menBtn.onmouseenter = () => { menBtn.style.background = '#f43f5e'; menBtn.style.color = '#000'; };
            menBtn.onmouseleave = () => { menBtn.style.background = '#111'; menBtn.style.color = '#f43f5e'; };
        }
        menu.style.display = 'flex';
    }

    hideEscMenu() {
        const menu = document.getElementById('pvp-esc-menu');
        if (menu) menu.style.display = 'none';
    }

    handleNetworkEvent(event) {
        if (event.type === 'update') {
            const np = this.networkPlayers.get(event.id);
            if (!np) return;
            np.updateData(event);

            if (event.event === 'reload') {
                if (!np.isDead) {
                    const dist = Phaser.Math.Distance.Between(this.player.sprite.x, this.player.sprite.y, np.container.x, np.container.y);
                    if (dist < 1680) {
                        const falloff = 1 - (dist / 1680);
                        const volume = Math.max(0.05, 0.7 * falloff);
                        this.sound.play('reload_sound', { volume });
                    }
                }
            }

            if (event.event === 'fire' && np.visual) {
                const muzzle = np.visual.getMuzzlePosition();
                const wpKey = event.weapon || 'pistol';
                const wpData = this.player.weapons.weaponData[wpKey];
                
                // Play proximity audio for remote gunfire/melee
                if (wpData && wpData.sound) {
                    const dist = Phaser.Math.Distance.Between(this.player.sprite.x, this.player.sprite.y, np.container.x, np.container.y);
                    if (dist < 1680) {
                        const falloff = 1 - (dist / 1680);
                        const maxVol = wpKey === 'dagger' ? 0.5 : 0.6;
                        const volume = Math.max(0.05, maxVol * falloff);
                        this.sound.play(wpData.sound, { volume });
                    }
                }

                if (wpKey === 'dagger') {
                    if (np.visual.playMeleeAnimation) np.visual.playMeleeAnimation();
                } else if (wpKey === 'sniper') {
                    const line = this.add.graphics();
                    line.lineStyle(2, 0xffffff, 0.8);
                    
                    const angle = Phaser.Math.Angle.Between(muzzle.x, muzzle.y, event.targetX, event.targetY);
                    const maxRange = wpData ? wpData.range : 16000;
                    let endX = muzzle.x + Math.cos(angle) * maxRange;
                    let endY = muzzle.y + Math.sin(angle) * maxRange;
                    
                    // Raycast for local visual termination (platforms and local player)
                    const step = 10;
                    for (let d = 0; d < maxRange; d += step) {
                        const px = muzzle.x + Math.cos(angle) * d;
                        const py = muzzle.y + Math.sin(angle) * d;
                        
                        const hitWall = this.platforms.getTileAtWorldXY(px, py, true)?.canCollide ||
                                        this.physicsDetails.getChildren().find(w => w.active && w.getBounds().contains(px, py));
                        const hitLocalPlayer = this.player.sprite.active && this.player.sprite.body &&
                                               Phaser.Geom.Rectangle.Contains(this.player.sprite.body, px, py);
                                               
                        if (hitWall || hitLocalPlayer) {
                            endX = px;
                            endY = py;
                            break;
                        }
                    }
                    
                    line.lineBetween(muzzle.x, muzzle.y, endX, endY);
                    this.tweens.add({ targets: line, alpha: 0, duration: 150, onComplete: () => line.destroy() });
                } else if (wpKey.includes('shotgun')) {
                    // SHOTGUN FAN SYNC (Golden Pellets like Solo)
                    const baseAngle = Phaser.Math.Angle.Between(muzzle.x, muzzle.y, event.targetX, event.targetY);
                    const spreadRad = Phaser.Math.DegToRad(wpData.fanAngle || 15);
                    const step = spreadRad / (wpData.pellets - 1);
                    const startAngle = baseAngle - (spreadRad / 2);

                    for (let i = 0; i < wpData.pellets; i++) {
                        const angle = startAngle + (step * i);
                        const b = this.add.sprite(muzzle.x, muzzle.y, 'white_square');
                        b.setDisplaySize(4, 4); 
                        b.setTint(0xffd700); // Golden
                        this.physics.add.existing(b);
                        b.body.setAllowGravity(false);
                        b.body.setVelocity(Math.cos(angle) * 1200, Math.sin(angle) * 1200);
                        
                        // Local collision for visual destruction
                        this.physics.add.collider(b, [this.platforms, this.physicsDetails], () => b.destroy());
                        this.physics.add.overlap(b, this.player.sprite, () => b.destroy());
                         this.time.delayedCall(1500, () => b.destroy());
                    }
                } else if (wpKey === 'launcher') {
                    // ROCKET SYNC
                    const b = this.add.sprite(muzzle.x, muzzle.y, 'rocket');
                    b.setDisplaySize(45, 22);
                    this.physics.add.existing(b);
                    b.body.setAllowGravity(false);
                    b.body.setSize(10, 10);
                    b.body.setOffset(17, 6);
                    const angle = Phaser.Math.Angle.Between(muzzle.x, muzzle.y, event.targetX, event.targetY);
                    b.body.setVelocity(Math.cos(angle) * 800, Math.sin(angle) * 800);
                    b.setRotation(angle);
                    
                    // Local collision for visual destruction
                    this.time.delayedCall(300, () => {
                        if (b.active) {
                            this.physics.add.collider(b, [this.platforms, this.physicsDetails], () => b.destroy());
                        }
                    });
                    this.physics.add.overlap(b, this.player.sprite, () => b.destroy());
                    
                    this.time.delayedCall(5000, () => b.destroy());
                } else {
                    const bullet = this.add.sprite(muzzle.x, muzzle.y, 'bullet');
                    bullet.setDisplaySize(20, 10);
                    this.physics.add.existing(bullet);
                    bullet.body.setAllowGravity(false);
                    const angle = Phaser.Math.Angle.Between(muzzle.x, muzzle.y, event.targetX, event.targetY);
                    bullet.body.setVelocity(Math.cos(angle) * 1200, Math.sin(angle) * 1200);
                    bullet.setRotation(angle + Math.PI);
                    
                    // Local collision for visual destruction
                    this.time.delayedCall(100, () => {
                        if (bullet.active) {
                            this.physics.add.collider(bullet, [this.platforms, this.physicsDetails], () => bullet.destroy());
                        }
                    });
                    this.physics.add.overlap(bullet, this.player.sprite, () => bullet.destroy());
                    this.time.delayedCall(3000, () => bullet.destroy());
                }
            }

            if (event.event === 'explosion') {
                this.player.weapons.createExplosion(event.x, event.y, event.radius, 0, null, true);
                
                // Clear any remote grenade nearby
                this.remoteGrenades.forEach((g, id) => {
                    if (Phaser.Math.Distance.Between(g.x, g.y, event.x, event.y) < 100) {
                        g.destroy();
                        this.remoteGrenades.delete(id);
                    }
                });
            }

            if (event.event === 'spawn_loot') {
                this.spawnWeaponPickup(event.x, event.y, event.weaponKey, event.ammo, false, -1, false, event.lootId, event.vx);
            }

            if (event.event === 'despawn_loot') {
                const pickup = this.weaponPickups.getChildren().find(p => p.lootId === event.lootId);
                if (pickup) pickup.destroy();
            }

            if (event.event === 'death') {
                const np = this.networkPlayers.get(event.id);
                if (np && np.visual) {
                    np.isDead = true; // Lock visibility
                    np.lastPacketTime = event.timestamp || Date.now();
                    np.visual.explode();
                }
            }

            if (event.event === 'grenade') {
                const grenade = this.add.sprite(event.x, event.y, 'grenade');
                grenade.setDisplaySize(33, 33);
                this.physics.add.existing(grenade);
                grenade.body.setVelocity(event.vx, event.vy);
                grenade.body.setBounce(0.6);
                grenade.body.setCircle(12);
                grenade.body.setDrag(50);
                this.physics.add.collider(grenade, [this.platforms, this.physicsDetails]);
                this.physics.add.collider(grenade, this.player.sprite);
                
                if (event.grenadeId) {
                    this.remoteGrenades.set(event.grenadeId, grenade);
                }
                
                this.time.delayedCall(2500, () => {
                    if (grenade.active) {
                        this.player.weapons.createExplosion(grenade.x, grenade.y, 150, 0, null, true);
                        if (event.grenadeId) this.remoteGrenades.delete(event.grenadeId);
                        grenade.destroy();
                    }
                });
            }

            if (event.event === 'grenade_sync') {
                const g = this.remoteGrenades.get(event.grenadeId);
                if (g && g.active) {
                    g.setPosition(event.x, event.y);
                }
            }

            if (event.event === 'hit' && event.targetId === PvPManager.socket.id) {
                this.player.takeDamage(event.damage, event.id);
            }
        }
    }

    onPlayerDeath(killerId) {
        if (this.player.isRespawning) return; // Prevent loop
        this.player.isRespawning = true; // LOCK DAMAGE LOOP
        
        const currentWeapon = this.player.weapons.inventory[this.player.weapons.currentSlot];
        const currentAmmo = this.player.weapons.ammo[this.player.weapons.currentSlot];
        
        // Generate a shared lootId and velocity for the death drop
        const deathLootId = `death_${this.player.id}_${Date.now()}`;
        const deathVx = Phaser.Math.Between(-100, 100);

        // Notify others of death + weapon state
        PvPManager.sendPlayerUpdate({ 
            event: 'death', 
            weapon: currentWeapon, 
            ammo: currentAmmo,
            lootId: deathLootId,
            vx: deathVx,
            timestamp: Date.now()
        });

        // Emit KILL event to server to update score
        if (killerId && killerId !== PvPManager.socket.id) {
            PvPManager.socket.emit('player_update', {
                code: PvPManager.currentRoom,
                event: 'kill',
                killerId: killerId,
                victimId: PvPManager.socket.id
            });
        }

        if (currentWeapon && currentWeapon !== 'dagger') {
            this.spawnWeaponPickup(this.player.sprite.x, this.player.sprite.y, currentWeapon, currentAmmo, false, -1, true, deathLootId, deathVx);
        }
        
        if (this.player.visual && this.player.visual.explode) {
            this.player.visual.explode();
        }

        this.time.delayedCall(1300, () => this.cameras.main.fadeOut(500));
        this.time.delayedCall(2300, () => {
            const pvpStore = usePvPStore.getState();
            // Find Spawns again from the active map
            const spawnObjects = this.make.tilemap({ key: 'pvp_map' }).getObjectLayer('Spawns_And_Pickups')?.objects || [];
            const playerSpawns = spawnObjects.filter(obj => obj.name === 'player_spawn');
            const mySpawn = playerSpawns[Math.floor(Math.random() * playerSpawns.length)] || { x: 500, y: 500 };

            this.player.sprite.setPosition(mySpawn.x, mySpawn.y);
            this.player.health = 100;
            this.player.isRespawning = false;
            this.player.sprite.setActive(true).setVisible(false); // KEEP INVISIBLE
            this.player.sprite.body.setEnable(true);
            this.player.visual.reset();
            
            // RESET LOADOUT ON RESPAWN
            this.player.weapons.resetInventory();
            this.player.weapons.addWeapon('pistol');
            this.player.weapons.addWeapon('dagger');

            this.cameras.main.fadeIn(500);
        });
    }

    handlePvPHit(targetId, damage) {
        // This is called by explosions in WeaponSystem
        PvPManager.sendPlayerUpdate({ event: 'hit', targetId, damage });
    }

    handleLootPickup(pointIndex) {
        if (pointIndex === -1) return;
        // Notify server that this loot is GONE
        PvPManager.socket.emit('pickup_loot', { code: PvPManager.currentRoom, pointIndex });
    }

    removeLootLocally(pointIndex) {
        if (pointIndex >= 0 && pointIndex < this.lootPoints.length) {
            this.lootPoints[pointIndex].active = false;
        }
        this.weaponPickups.getChildren().forEach(p => {
            if (p.pointIndex === pointIndex) {
                p.destroy();
            }
        });
    }

    respawnLootLocally(pointIndex, weaponKey) {
        if (pointIndex < 0 || pointIndex >= this.lootPoints.length) return;
        const point = this.lootPoints[pointIndex];
        
        // Safety check to prevent double-spawning
        if (point.active) return;

        this.spawnWeaponPickup(point.x, point.y, weaponKey, null, true, point.index);
        point.active = true;
    }

    showResults(leaderboard) {
        if (!this.cameras || !this.cameras.main) return;
        const { width, height } = this.cameras.main;
        this.add.rectangle(0, 0, width, height, 0x000000, 0.85).setOrigin(0).setScrollFactor(0).setDepth(1000);
        this.add.text(width / 2, 100, 'MATCH RESULTS', { font: 'bold 40px monospace', fill: '#22d3ee' }).setOrigin(0.5).setScrollFactor(0).setDepth(1001);
        leaderboard.sort((a, b) => b.kills - a.kills).forEach((p, i) => {
            this.add.text(width / 2, 200 + (i * 40), `${p.name}: ${p.kills} KILLS`, { font: 'bold 20px monospace', fill: '#ffffff' }).setOrigin(0.5).setScrollFactor(0).setDepth(1001);
        });
        this.add.text(width / 2, height - 100, 'BACK TO LOBBY', { font: 'bold 24px monospace', fill: '#ffffff', backgroundColor: '#1e293b', padding: { x: 20, y: 10 } })
            .setOrigin(0.5).setScrollFactor(0).setDepth(1001).setInteractive({ useHandCursor: true })
            .on('pointerdown', () => this.scene.start('PvPLobby'));
    }
}
