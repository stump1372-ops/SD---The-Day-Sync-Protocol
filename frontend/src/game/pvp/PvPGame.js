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
        const details = map.createFromObjects('Physics_Details', { name: '', key: 'tileset_70' });
        details.forEach(detail => {
            detail.setDepth(5);
            detail.setVisible(false);
            this.physicsDetails.add(detail);
        });

        this.worldWidth = map.widthInPixels;
        this.worldHeight = map.heightInPixels;
        this.physics.world.setBounds(0, 0, this.worldWidth, this.worldHeight);
        this.cameras.main.setBounds(0, 0, this.worldWidth, this.worldHeight);

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
        this.physics.add.collider(this.player.sprite, [this.platforms]);
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
        this.physics.add.collider(this.enemies, [this.platforms]);
        this.physics.add.collider(this.weaponPickups, [this.platforms]);

        this.physics.add.collider(this.player.weapons.bullets, [this.platforms], (b) => {
            if (b.isRocket) b.onImpact(); else b.destroy();
        });

        // Hit registration: When local bullet hits a remote player (enemy)
        this.physics.add.overlap(this.player.weapons.bullets, this.enemies, this.bulletHitEnemy, null, this);

        // 7. UI & Networking
        PvPManager.gameScene = this;
        store.setShowHUD(true);
        this.matchText = this.add.text(width / 2, 20, '5:00', { font: 'bold 24px monospace', fill: '#ffffff' })
            .setOrigin(0.5).setScrollFactor(0).setDepth(100);

        this.unsubscribe = usePvPStore.subscribe((state) => {
            if (!state.isMatchStarted && state.leaderboard.length > 0) this.showResults(state.leaderboard);
        });

        // Event for Network Bullets (Visual Only)
        this.player.weapons.onFire = (data) => PvPManager.sendPlayerUpdate({ event: 'fire', ...data });
        
        // Event for Network Explosions
        this.onExplosion = (data) => PvPManager.sendPlayerUpdate({ event: 'explosion', ...data });
        
        // Event for Network Grenades
        this.onGrenade = (data) => PvPManager.sendPlayerUpdate({ event: 'grenade', ...data });
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
        
        pickup.setDisplaySize(60, 30);
        pickup.body.setSize(40, 20).setBounce(0.5).setDrag(100);

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

        // Send state to server
        PvPManager.sendPlayerUpdate({
            x: this.player.sprite.x,
            y: this.player.sprite.y,
            vx: this.player.sprite.body.velocity.x,
            vy: this.player.sprite.body.velocity.y,
            aimX: worldPoint.x,
            aimY: worldPoint.y,
            isCrouching: this.player.isCrouching,
            weapon: this.player.weapons.inventory[this.player.weapons.currentSlot]
        });

        // Update Remote Players
        this.networkPlayers.forEach(np => np.update(time, delta));

        // Timer
        const matchTime = usePvPStore.getState().matchTime;
        const mins = Math.floor(matchTime / 60);
        const secs = matchTime % 60;
        this.matchText.setText(`${mins}:${secs.toString().padStart(2, '0')}`);
    }

    handleNetworkEvent(event) {
        if (event.type === 'update') {
            const np = this.networkPlayers.get(event.id);
            if (!np) return;
            np.updateData(event);

            if (event.event === 'fire' && np.visual) {
                const muzzle = np.visual.getMuzzlePosition();
                const wpKey = event.weapon || 'pistol';
                const wpData = this.player.weapons.weaponData[wpKey];
                
                if (wpKey === 'sniper') {
                    const line = this.add.graphics();
                    line.lineStyle(2, 0xffffff, 0.8);
                    line.lineBetween(muzzle.x, muzzle.y, event.targetX, event.targetY);
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
                        this.physics.add.collider(b, this.platforms, () => b.destroy());
                        this.physics.add.overlap(b, this.player.sprite, () => b.destroy());
                        this.time.delayedCall(800, () => b.destroy());
                    }
                } else if (wpKey === 'launcher') {
                    // ROCKET SYNC
                    const b = this.add.sprite(muzzle.x, muzzle.y, 'rocket');
                    b.setDisplaySize(45, 22);
                    this.physics.add.existing(b);
                    b.body.setAllowGravity(false);
                    const angle = Phaser.Math.Angle.Between(muzzle.x, muzzle.y, event.targetX, event.targetY);
                    b.body.setVelocity(Math.cos(angle) * 800, Math.sin(angle) * 800);
                    b.setRotation(angle);
                    this.time.delayedCall(2000, () => b.destroy());
                } else {
                    const bullet = this.add.sprite(muzzle.x, muzzle.y, 'bullet');
                    bullet.setDisplaySize(20, 10);
                    this.physics.add.existing(bullet);
                    bullet.body.setAllowGravity(false);
                    const angle = Phaser.Math.Angle.Between(muzzle.x, muzzle.y, event.targetX, event.targetY);
                    bullet.body.setVelocity(Math.cos(angle) * 1200, Math.sin(angle) * 1200);
                    bullet.setRotation(angle + Math.PI);
                    
                    // Local collision for visual destruction
                    this.physics.add.collider(bullet, this.platforms, () => bullet.destroy());
                    this.physics.add.overlap(bullet, this.player.sprite, () => bullet.destroy());
                    this.time.delayedCall(1000, () => bullet.destroy());
                }
            }

            if (event.event === 'explosion') {
                this.player.weapons.createExplosion(event.x, event.y, event.radius, 0, null, true);
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
                this.physics.add.collider(grenade, this.platforms);
                this.physics.add.collider(grenade, this.player.sprite);
                
                this.time.delayedCall(2500, () => {
                    if (grenade.active) {
                        this.player.weapons.createExplosion(grenade.x, grenade.y, 150, 0, null, true);
                        grenade.destroy();
                    }
                });
            }

            if (event.event === 'hit' && event.targetId === PvPManager.socket.id) {
                this.player.takeDamage(event.damage);
            }
        }
    }

    onPlayerDeath() {
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
            vx: deathVx
        });

        if (currentWeapon && currentWeapon !== 'dagger') {
            this.spawnWeaponPickup(this.player.sprite.x, this.player.sprite.y, currentWeapon, currentAmmo, false, -1, true, deathLootId, deathVx);
        }
        
        this.cameras.main.fadeOut(500);
        this.time.delayedCall(1000, () => {
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
