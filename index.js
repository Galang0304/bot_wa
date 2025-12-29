const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ==========================================
// WEB SERVER SETUP
// ==========================================
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const WEB_PORT = process.env.PORT || 3010;

// ==========================================
// FILE PATHS
// ==========================================
const OUTPUT_FILE = path.join(__dirname, 'nomor_telepon.txt');
const UNIQUE_FILE = path.join(__dirname, 'nomor_unik.txt');
const LOG_FILE = path.join(__dirname, 'broadcast_log.txt');
const SENT_FILE = path.join(__dirname, 'nomor_terkirim.txt');
const MESSAGE_FILE = path.join(__dirname, 'pesan_broadcast.txt');

// ==========================================
// KONFIGURASI BROADCAST ANTI-BAN
// ==========================================
const BROADCAST_CONFIG = {
    DELAY: 30,              // Delay 30 detik
    MAX_PER_SESSION: 50,    // Maksimal 50 pesan per sesi
};

// ==========================================
// GLOBAL VARIABLES
// ==========================================
let uniqueNumbers = new Set();
let sentNumbers = new Set();
let client = null;
let isReady = false;
let isBroadcasting = false;
let broadcastMessage = '';
let currentQR = '';
let broadcastProgress = { current: 0, total: 0, success: 0, fail: 0 };

// ==========================================
// UTILITY FUNCTIONS
// ==========================================
function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomPick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function log(message) {
    const timestamp = new Date().toLocaleString('id-ID');
    const logEntry = `[${timestamp}] ${message}`;
    console.log(logEntry);
    fs.appendFileSync(LOG_FILE, logEntry + '\n');
}

function formatNumber(number) {
    let formatted = number.replace(/[^0-9]/g, '');
    return formatted + '@c.us';
}

// ==========================================
// DATA MANAGEMENT
// ==========================================
function loadExistingNumbers() {
    try {
        if (fs.existsSync(UNIQUE_FILE)) {
            const data = fs.readFileSync(UNIQUE_FILE, 'utf8');
            const numbers = data.split('\n').filter(n => n.trim());
            numbers.forEach(n => uniqueNumbers.add(n.trim()));
            console.log(`📂 Loaded ${uniqueNumbers.size} nomor yang sudah ada`);
        }
    } catch (err) {
        console.log('📂 Mulai dengan database kosong');
    }
}

function loadSentNumbers() {
    try {
        if (fs.existsSync(SENT_FILE)) {
            const data = fs.readFileSync(SENT_FILE, 'utf8');
            const numbers = data.split('\n').filter(n => n.trim());
            numbers.forEach(n => sentNumbers.add(n.trim()));
        }
    } catch (err) {
        // Ignore
    }
}

function saveNumber(number, name = '') {
    let normalized = number.replace(/[^0-9+]/g, '');
    if (normalized.length < 10) return false;
    
    if (normalized.startsWith('08')) {
        normalized = '+62' + normalized.substring(1);
    } else if (normalized.startsWith('62')) {
        normalized = '+' + normalized;
    } else if (!normalized.startsWith('+')) {
        normalized = '+' + normalized;
    }
    
    if (uniqueNumbers.has(normalized)) return false;
    
    uniqueNumbers.add(normalized);
    const entry = name ? `${normalized} - ${name}` : normalized;
    fs.appendFileSync(OUTPUT_FILE, entry + '\n');
    fs.writeFileSync(UNIQUE_FILE, Array.from(uniqueNumbers).join('\n'));
    
    console.log(`✅ Nomor baru disimpan: ${normalized}${name ? ' (' + name + ')' : ''}`);
    return true;
}

function saveSentNumber(number) {
    sentNumbers.add(number);
    fs.appendFileSync(SENT_FILE, number + '\n');
}

function extractPhoneNumbers(text) {
    if (!text) return [];
    const patterns = [
        /(\+62|62|0)[\s.-]?8[1-9][0-9][\s.-]?[0-9]{3,4}[\s.-]?[0-9]{3,4}/g,
        /(\+62|62|0)[\s.-]?[2-9][0-9]{1,2}[\s.-]?[0-9]{3,4}[\s.-]?[0-9]{3,4}/g,
        /08[0-9]{8,11}/g
    ];
    const found = [];
    for (const pattern of patterns) {
        const matches = text.match(pattern);
        if (matches) found.push(...matches);
    }
    return [...new Set(found)];
}

// ==========================================
// BROADCAST FUNCTIONS
// ==========================================
function loadBroadcastMessage() {
    try {
        if (fs.existsSync(MESSAGE_FILE)) {
            broadcastMessage = fs.readFileSync(MESSAGE_FILE, 'utf8').trim();
            if (broadcastMessage) {
                console.log('📝 Pesan broadcast loaded!');
            }
        }
    } catch (err) {
        // Ignore
    }
}

function saveBroadcastMessage(message) {
    broadcastMessage = message;
    fs.writeFileSync(MESSAGE_FILE, message);
}

function createMessage() {
    if (!broadcastMessage) return null;
    
    let message = broadcastMessage;
    
    // Invisible char untuk variasi (anti-ban)
    const invisibleChars = ['\u200B', '\u200C', '\u200D', '\uFEFF'];
    message = message + randomPick(invisibleChars);
    
    // Tambah variasi random di awal/akhir
    const randomSpaces = ' '.repeat(randomBetween(0, 2));
    message = randomSpaces + message;
    
    return message;
}

async function startBroadcast(replyFunc = null) {
    if (!isReady) {
        const msg = '❌ WhatsApp belum siap! Tunggu sampai terhubung.';
        console.log(msg);
        if (replyFunc) await replyFunc(msg);
        io.emit('broadcast-error', 'WhatsApp belum terhubung!');
        return;
    }
    
    if (isBroadcasting) {
        const msg = '⚠️ Broadcast sedang berjalan!';
        console.log(msg);
        if (replyFunc) await replyFunc(msg);
        return;
    }
    
    if (!broadcastMessage) {
        const msg = '❌ Belum ada pesan broadcast!\n\nGunakan:\n`!setpesan [isi pesan]`\n\nContoh:\n`!setpesan Halo kak, kami ada promo nih!`';
        console.log(msg);
        if (replyFunc) await replyFunc(msg);
        io.emit('broadcast-error', 'Set pesan dulu!');
        return;
    }
    
    isBroadcasting = true;
    
    console.log('\n');
    console.log('📢 MEMULAI BROADCAST');
    console.log('====================');
    
    // Get numbers to send
    const allNumbers = Array.from(uniqueNumbers);
    const numbersToSend = allNumbers.filter(n => !sentNumbers.has(n));
    const limitedNumbers = numbersToSend.slice(0, BROADCAST_CONFIG.MAX_PER_SESSION);
    
    console.log(`📱 Total nomor: ${allNumbers.length}`);
    console.log(`✅ Sudah terkirim: ${sentNumbers.size}`);
    console.log(`📤 Akan dikirim: ${limitedNumbers.length}`);
    console.log('');
    
    if (limitedNumbers.length === 0) {
        console.log('⚠️ Tidak ada nomor baru untuk di-broadcast!');
        isBroadcasting = false;
        io.emit('broadcast-error', 'Tidak ada nomor baru!');
        return;
    }
    
    let successCount = 0;
    let failCount = 0;
    
    for (let i = 0; i < limitedNumbers.length; i++) {
        // Check if still connected
        if (!isReady) {
            console.log('\n⚠️ WhatsApp terputus! Broadcast dihentikan.');
            io.emit('broadcast-error', 'WhatsApp terputus! Broadcast dihentikan.');
            break;
        }
        const number = limitedNumbers[i];
        const formattedNumber = formatNumber(number);
        
        console.log(`\n[${i + 1}/${limitedNumbers.length}] Mengirim ke ${number}...`);
        
        try {
            // Cek apakah nomor terdaftar di WhatsApp
            const isRegistered = await client.isRegisteredUser(formattedNumber);
            
            if (isRegistered) {
                const message = createMessage();
                
                await client.sendMessage(formattedNumber, message);
                
                log(`✅ Terkirim ke ${number}`);
                saveSentNumber(number);
                successCount++;
            } else {
                log(`⚠️ ${number} tidak terdaftar di WhatsApp`);
                failCount++;
            }
            
            // Update progress ke dashboard
            broadcastProgress = {
                current: i + 1,
                total: limitedNumbers.length,
                success: successCount,
                fail: failCount
            };
            io.emit('broadcast-progress', broadcastProgress);
            
            // Delay 30 detik
            if (i < limitedNumbers.length - 1) {
                console.log(`⏳ Menunggu 30 detik...`);
                await sleep(BROADCAST_CONFIG.DELAY * 1000);
            }
            
        } catch (err) {
            log(`❌ Gagal kirim ke ${number}: ${err.message}`);
            failCount++;
        }
    }
    
    console.log('\n');
    console.log('==========================================');
    console.log('📊 HASIL BROADCAST');
    console.log('==========================================');
    log(`✅ Berhasil: ${successCount}`);
    log(`❌ Gagal: ${failCount}`);
    console.log('==========================================');
    
    isBroadcasting = false;
    io.emit('broadcast-done', { success: successCount, fail: failCount });
}

// ==========================================
// WHATSAPP CLIENT SETUP
// ==========================================
function initializeClient() {
    client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            headless: true,  // Headless mode
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ]
        }
    });

    client.on('qr', async (qr) => {
        console.log('\n📱 QR Code tersedia! Buka http://localhost:3000 untuk scan\n');
        qrcode.generate(qr, { small: true });
        
        // Generate QR untuk web
        currentQR = await QRCode.toDataURL(qr);
        io.emit('qr', currentQR);
    });

    client.on('loading_screen', (percent, message) => {
        console.log(`⏳ Loading: ${percent}% - ${message}`);
        io.emit('loading', { percent, message });
    });

    client.on('authenticated', () => {
        console.log('✅ Autentikasi berhasil!');
        currentQR = '';
        io.emit('authenticated');
    });

    client.on('ready', () => {
        isReady = true;
        console.log('\n');
        console.log('✅ WhatsApp Bot Siap!');
        console.log('');
        io.emit('ready');
        showInteractiveMenu();
    });

    // Message handler
    client.on('message', async (msg) => {
        await handleMessage(msg);
    });

    client.on('disconnected', async (reason) => {
        console.log('❌ Terputus:', reason);
        isReady = false;
        isBroadcasting = false;  // Stop broadcast jika disconnect
        io.emit('disconnected', reason);
        
        // Auto restart
        await restartBot();
    });

    client.on('auth_failure', async (err) => {
        console.error('❌ Autentikasi gagal:', err);
        io.emit('auth-failure', err);
        
        // Hapus sesi lama dan restart
        console.log('🗑️ Menghapus sesi lama...');
        try {
            const authPath = path.join(__dirname, '.wwebjs_auth');
            if (fs.existsSync(authPath)) {
                fs.rmSync(authPath, { recursive: true, force: true });
            }
        } catch(e) {}
        
        await restartBot();
    });

    console.log('⏳ Memulai WhatsApp Web...');
    client.initialize();
}

// ==========================================
// MESSAGE HANDLER
// ==========================================
async function handleMessage(msg) {
    const body = msg.body.toLowerCase().trim();
    const chat = await msg.getChat();
    
    // Auto save sender number
    if (msg.from) {
        const senderNumber = msg.from.split('@')[0];
        if (senderNumber.length >= 10) {
            try {
                const contact = await msg.getContact();
                const name = contact?.pushname || contact?.name || '';
                saveNumber(senderNumber, name);
            } catch(e) {}
        }
    }
    
    // Auto save numbers from message
    const numbersInMessage = extractPhoneNumbers(msg.body);
    for (const num of numbersInMessage) {
        saveNumber(num);
    }
    
    // Handle vCard/contact share
    if (msg.type === 'vcard' || msg.type === 'multi_vcard') {
        try {
            const vcardData = msg.vCards || [msg.body];
            let savedContacts = [];
            
            for (const vcard of vcardData) {
                const telMatch = vcard.match(/TEL[^:]*:([+\d\s-]+)/gi);
                if (telMatch) {
                    for (const tel of telMatch) {
                        const phoneNum = tel.replace(/TEL[^:]*:/i, '').trim();
                        const nameMatch = vcard.match(/FN:(.+)/i);
                        const contactName = nameMatch ? nameMatch[1].trim() : '';
                        if (saveNumber(phoneNum, contactName)) {
                            savedContacts.push(`${phoneNum}${contactName ? ' - ' + contactName : ''}`);
                        }
                    }
                }
            }
            
            if (savedContacts.length > 0) {
                await msg.reply(`✅ *${savedContacts.length} kontak disimpan!*\n\n${savedContacts.join('\n')}\n\n📊 Total: ${uniqueNumbers.size} nomor`);
            }
        } catch(e) {}
    }
    
    // Commands
    if (body === '!help' || body === '!menu') {
        await msg.reply(
            '📱 *WhatsApp Bot - All in One*\n\n' +
            '*📥 EKSTRAK NOMOR:*\n' +
            '• `!hasil` - Kirim semua nomor\n' +
            '• `!ambil` - Ambil dari 100 pesan terakhir\n' +
            '• `!ambil 500` - Ambil dari 500 pesan\n' +
            '• `!ambilkontak` - Ambil anggota grup\n' +
            '• `!total` - Lihat total nomor\n\n' +
            '*📢 BROADCAST:*\n' +
            '• `!setpesan [isi]` - Set pesan broadcast\n' +
            '• `!lihatpesan` - Lihat pesan saat ini\n' +
            '• `!broadcast` - Mulai broadcast\n' +
            '• `!statusbc` - Status broadcast\n' +
            '• `!resetbc` - Reset nomor terkirim\n\n' +
            '• `!reset` - Hapus semua data\n\n' +
            '_Forward kontak = otomatis tersimpan!_'
        );
        return;
    }
    
    // SET PESAN BROADCAST
    if (msg.body.startsWith('!setpesan ')) {
        const pesan = msg.body.substring(10).trim();
        if (!pesan) {
            await msg.reply('❌ Pesan tidak boleh kosong!\n\nContoh:\n`!setpesan Halo kak, kami ada promo nih!`');
            return;
        }
        saveBroadcastMessage(pesan);
        await msg.reply(
            `✅ *Pesan broadcast disimpan!*\n\n` +
            `📝 Isi pesan:\n${pesan}\n\n` +
            `Ketik \`!broadcast\` untuk mulai kirim.`
        );
        console.log(`📝 Pesan broadcast di-set: ${pesan.substring(0, 50)}...`);
        return;
    }
    
    // LIHAT PESAN
    if (body === '!lihatpesan' || body === '!cekpesan') {
        if (!broadcastMessage) {
            await msg.reply('📭 Belum ada pesan broadcast.\n\nGunakan:\n`!setpesan [isi pesan]`');
        } else {
            await msg.reply(`📝 *Pesan Broadcast Saat Ini:*\n\n${broadcastMessage}`);
        }
        return;
    }
    
    if (body === '!hasil' || body === '!nomor' || body === '!list') {
        if (uniqueNumbers.size === 0) {
            await msg.reply('📭 Belum ada nomor tersimpan.');
            return;
        }
        const allNumbers = Array.from(uniqueNumbers);
        let result = `📱 *DAFTAR NOMOR*\n📊 Total: ${allNumbers.length}\n${'─'.repeat(20)}\n\n`;
        for (let i = 0; i < allNumbers.length; i++) {
            result += `${i + 1}. ${allNumbers[i]}\n`;
        }
        if (result.length > 4000) {
            const chunks = result.match(/.{1,4000}/gs);
            for (const chunk of chunks) {
                await msg.reply(chunk);
                await sleep(500);
            }
        } else {
            await msg.reply(result);
        }
        return;
    }
    
    if (body === '!reset') {
        uniqueNumbers.clear();
        fs.writeFileSync(OUTPUT_FILE, '');
        fs.writeFileSync(UNIQUE_FILE, '');
        await msg.reply('🗑️ Semua data nomor sudah dihapus!');
        return;
    }
    
    if (body === '!total') {
        await msg.reply(`📊 Total nomor unik: *${uniqueNumbers.size}*\n✅ Sudah terkirim broadcast: *${sentNumbers.size}*`);
        return;
    }
    
    if (body === '!broadcast' || body === '!bc') {
        if (isBroadcasting) {
            await msg.reply('⚠️ Broadcast sedang berjalan! Tunggu sampai selesai.');
            return;
        }
        if (!broadcastMessage) {
            await msg.reply('❌ Belum ada pesan broadcast!\n\nGunakan:\n`!setpesan [isi pesan]`\n\nContoh:\n`!setpesan Halo kak, kami ada promo nih!`');
            return;
        }
        await msg.reply(`📢 Memulai broadcast...\n\n📝 Pesan:\n${broadcastMessage}\n\nCek console untuk progress.`);
        startBroadcast(async (m) => await msg.reply(m));
        return;
    }
    
    if (body === '!statusbc') {
        const remaining = Array.from(uniqueNumbers).filter(n => !sentNumbers.has(n)).length;
        let status = `📊 *Status Broadcast*\n\n`;
        status += `📝 Pesan: ${broadcastMessage ? 'Sudah di-set ✅' : 'Belum di-set ❌'}\n`;
        status += `📱 Total nomor: ${uniqueNumbers.size}\n`;
        status += `✅ Sudah terkirim: ${sentNumbers.size}\n`;
        status += `📤 Belum terkirim: ${remaining}\n`;
        status += `🔄 Status: ${isBroadcasting ? 'SEDANG BERJALAN' : 'IDLE'}`;
        
        if (broadcastMessage) {
            status += `\n\n📝 Isi pesan:\n${broadcastMessage.substring(0, 200)}${broadcastMessage.length > 200 ? '...' : ''}`;
        }
        await msg.reply(status);
        return;
    }
    
    if (body === '!resetbc') {
        sentNumbers.clear();
        fs.writeFileSync(SENT_FILE, '');
        await msg.reply('🔄 Data broadcast di-reset! Semua nomor bisa dikirim ulang.');
        return;
    }
    
    if (body === '!ambilkontak') {
        if (!chat.isGroup) {
            await msg.reply('❌ Perintah ini hanya untuk grup!');
            return;
        }
        await msg.reply('⏳ Mengambil nomor dari anggota grup...');
        try {
            const participants = chat.participants || [];
            let newCount = 0;
            for (const participant of participants) {
                const number = participant.id.user;
                const contact = await client.getContactById(participant.id._serialized);
                const name = contact.pushname || contact.name || '';
                if (saveNumber(number, name)) newCount++;
            }
            await msg.reply(`✅ Selesai!\n👥 Anggota: ${participants.length}\n📱 Baru: ${newCount}\n📊 Total: ${uniqueNumbers.size}`);
        } catch (err) {
            await msg.reply('❌ Error: ' + err.message);
        }
        return;
    }
    
    if (body.startsWith('!ambil')) {
        const limit = parseInt(body.split(' ')[1]) || 100;
        await msg.reply(`⏳ Mengambil dari ${limit} pesan...`);
        try {
            const messages = await chat.fetchMessages({ limit });
            let newCount = 0;
            for (const message of messages) {
                if (message.from) {
                    const senderNumber = message.from.split('@')[0];
                    const contact = await message.getContact();
                    const name = contact?.pushname || contact?.name || '';
                    if (saveNumber(senderNumber, name)) newCount++;
                }
                const nums = extractPhoneNumbers(message.body);
                for (const num of nums) {
                    if (saveNumber(num)) newCount++;
                }
            }
            await msg.reply(`✅ Selesai!\n📨 Diproses: ${messages.length}\n📱 Baru: ${newCount}\n📊 Total: ${uniqueNumbers.size}`);
        } catch (err) {
            await msg.reply('❌ Error: ' + err.message);
        }
        return;
    }
}

// ==========================================
// INTERACTIVE CONSOLE MENU
// ==========================================
function showInteractiveMenu() {
    console.log('==========================================');
    console.log('📱 WhatsApp Bot - All in One');
    console.log('==========================================');
    console.log('');
    console.log('🤖 BOT AKTIF! Perintah via WhatsApp:');
    console.log('   !help      - Lihat semua perintah');
    console.log('   !broadcast - Mulai broadcast');
    console.log('   !total     - Lihat total nomor');
    console.log('');
    console.log('💻 PERINTAH CONSOLE:');
    console.log('   1 - Mulai Broadcast');
    console.log('   2 - Lihat Status');
    console.log('   3 - Reset Broadcast');
    console.log('   0 - Keluar');
    console.log('');
    console.log(`📊 Nomor tersimpan: ${uniqueNumbers.size}`);
    console.log(`✅ Sudah terkirim: ${sentNumbers.size}`);
    console.log('==========================================');
    console.log('');
    
    startConsoleInput();
}

function startConsoleInput() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    
    rl.on('line', async (input) => {
        const cmd = input.trim();
        
        if (cmd === '1') {
            if (!broadcastMessage) {
                console.log('\n❌ Belum ada pesan broadcast!');
                console.log('   Set via WhatsApp: !setpesan [isi pesan]\n');
            } else {
                console.log('\n📢 Memulai broadcast dari console...');
                startBroadcast();
            }
        } else if (cmd === '2') {
            const remaining = Array.from(uniqueNumbers).filter(n => !sentNumbers.has(n)).length;
            console.log('\n📊 STATUS:');
            console.log(`   Pesan: ${broadcastMessage ? 'Sudah di-set ✅' : 'Belum di-set ❌'}`);
            console.log(`   Total nomor: ${uniqueNumbers.size}`);
            console.log(`   Sudah terkirim: ${sentNumbers.size}`);
            console.log(`   Belum terkirim: ${remaining}`);
            console.log(`   Status: ${isBroadcasting ? 'BROADCASTING' : 'IDLE'}`);
            if (broadcastMessage) {
                console.log(`\n📝 Isi pesan:\n   ${broadcastMessage.substring(0, 100)}${broadcastMessage.length > 100 ? '...' : ''}\n`);
            }
        } else if (cmd === '3') {
            sentNumbers.clear();
            fs.writeFileSync(SENT_FILE, '');
            console.log('\n🔄 Data broadcast di-reset!\n');
        } else if (cmd === '0') {
            console.log('\n👋 Menutup bot...');
            await client.destroy();
            process.exit(0);
        }
    });
}

// ==========================================
// WEB DASHBOARD
// ==========================================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WhatsApp Bot Dashboard</title>
    <script src="/socket.io/socket.io.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
        }
        h1 {
            color: white;
            text-align: center;
            margin-bottom: 30px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.2);
        }
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
        }
        .card {
            background: white;
            border-radius: 15px;
            padding: 25px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
        }
        .card h2 {
            color: #333;
            margin-bottom: 15px;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .qr-container {
            text-align: center;
            padding: 20px;
        }
        .qr-container img {
            max-width: 280px;
            border-radius: 10px;
            box-shadow: 0 5px 15px rgba(0,0,0,0.1);
        }
        .status {
            display: inline-block;
            padding: 8px 16px;
            border-radius: 20px;
            font-weight: bold;
            font-size: 14px;
        }
        .status.connected { background: #4CAF50; color: white; }
        .status.waiting { background: #FF9800; color: white; }
        .status.disconnected { background: #f44336; color: white; }
        .stats {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 15px;
            margin-top: 15px;
        }
        .stat-box {
            background: #f5f5f5;
            padding: 15px;
            border-radius: 10px;
            text-align: center;
        }
        .stat-box .number {
            font-size: 28px;
            font-weight: bold;
            color: #333;
        }
        .stat-box .label {
            font-size: 12px;
            color: #666;
            margin-top: 5px;
        }
        .progress-bar {
            width: 100%;
            height: 20px;
            background: #e0e0e0;
            border-radius: 10px;
            overflow: hidden;
            margin: 15px 0;
        }
        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #4CAF50, #8BC34A);
            transition: width 0.3s;
            border-radius: 10px;
        }
        .message-box {
            background: #f5f5f5;
            padding: 15px;
            border-radius: 10px;
            margin-top: 15px;
            white-space: pre-wrap;
            font-size: 14px;
            max-height: 200px;
            overflow-y: auto;
        }
        .btn {
            padding: 12px 25px;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            cursor: pointer;
            margin: 5px;
            transition: transform 0.2s;
        }
        .btn:hover { transform: scale(1.05); }
        .btn-primary { background: #4CAF50; color: white; }
        .btn-danger { background: #f44336; color: white; }
        .btn-warning { background: #FF9800; color: white; }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .actions { margin-top: 20px; text-align: center; }
        .log-container {
            max-height: 200px;
            overflow-y: auto;
            background: #1a1a2e;
            color: #0f0;
            padding: 15px;
            border-radius: 10px;
            font-family: monospace;
            font-size: 12px;
        }
        .log-entry { margin: 5px 0; }
        .log-success { color: #4CAF50; }
        .log-error { color: #f44336; }
        .log-warning { color: #FF9800; }
        textarea {
            width: 100%;
            height: 120px;
            padding: 15px;
            border: 2px solid #e0e0e0;
            border-radius: 10px;
            font-size: 14px;
            resize: vertical;
            margin-top: 10px;
        }
        textarea:focus { border-color: #667eea; outline: none; }
    </style>
</head>
<body>
    <div class="container">
        <h1>📱 WhatsApp Bot Dashboard</h1>
        
        <div class="grid">
            <!-- QR Code Card -->
            <div class="card">
                <h2>🔐 Koneksi WhatsApp</h2>
                <div class="qr-container">
                    <div id="qr-section">
                        <p>⏳ Menunggu QR Code...</p>
                    </div>
                    <div style="margin-top: 15px;">
                        <span id="connection-status" class="status waiting">Menunggu</span>
                    </div>
                </div>
            </div>
            
            <!-- Stats Card -->
            <div class="card">
                <h2>📊 Statistik</h2>
                <div class="stats">
                    <div class="stat-box">
                        <div class="number" id="total-numbers">0</div>
                        <div class="label">Total Nomor</div>
                    </div>
                    <div class="stat-box">
                        <div class="number" id="sent-numbers">0</div>
                        <div class="label">Terkirim</div>
                    </div>
                    <div class="stat-box">
                        <div class="number" id="remaining-numbers">0</div>
                        <div class="label">Belum Kirim</div>
                    </div>
                    <div class="stat-box">
                        <div class="number" id="failed-numbers">0</div>
                        <div class="label">Gagal</div>
                    </div>
                </div>
            </div>
            
            <!-- Broadcast Card -->
            <div class="card">
                <h2>📢 Broadcast</h2>
                <label><strong>Pesan Broadcast:</strong></label>
                <textarea id="broadcast-message" placeholder="Tulis pesan broadcast di sini..."></textarea>
                <div class="actions">
                    <button class="btn btn-primary" id="btn-save-message">💾 Simpan Pesan</button>
                    <button class="btn btn-primary" id="btn-broadcast" disabled>🚀 Mulai Broadcast</button>
                    <button class="btn btn-warning" id="btn-reset">🔄 Reset</button>
                </div>
                <div class="progress-bar" style="display: none;" id="progress-container">
                    <div class="progress-fill" id="progress-fill" style="width: 0%"></div>
                </div>
                <p id="progress-text" style="text-align: center; margin-top: 10px; display: none;"></p>
            </div>
            
            <!-- Log Card -->
            <div class="card">
                <h2>📋 Log Aktivitas</h2>
                <div class="log-container" id="log-container">
                    <div class="log-entry">Menunggu koneksi...</div>
                </div>
            </div>
        </div>
    </div>
    
    <script>
        const socket = io();
        
        // Elements
        const qrSection = document.getElementById('qr-section');
        const statusEl = document.getElementById('connection-status');
        const totalEl = document.getElementById('total-numbers');
        const sentEl = document.getElementById('sent-numbers');
        const remainingEl = document.getElementById('remaining-numbers');
        const failedEl = document.getElementById('failed-numbers');
        const messageEl = document.getElementById('broadcast-message');
        const btnBroadcast = document.getElementById('btn-broadcast');
        const btnSave = document.getElementById('btn-save-message');
        const btnReset = document.getElementById('btn-reset');
        const progressContainer = document.getElementById('progress-container');
        const progressFill = document.getElementById('progress-fill');
        const progressText = document.getElementById('progress-text');
        const logContainer = document.getElementById('log-container');
        
        function addLog(message, type = '') {
            const entry = document.createElement('div');
            entry.className = 'log-entry ' + type;
            entry.textContent = new Date().toLocaleTimeString() + ' - ' + message;
            logContainer.appendChild(entry);
            logContainer.scrollTop = logContainer.scrollHeight;
        }
        
        // Socket events
        socket.on('qr', (qr) => {
            qrSection.innerHTML = '<img src="' + qr + '" alt="QR Code"><p style="margin-top:10px">Scan dengan WhatsApp</p>';
            statusEl.textContent = 'Scan QR';
            statusEl.className = 'status waiting';
            addLog('QR Code tersedia, silakan scan', 'log-warning');
        });
        
        socket.on('authenticated', () => {
            addLog('Autentikasi berhasil!', 'log-success');
        });
        
        socket.on('ready', () => {
            qrSection.innerHTML = '<p style="font-size: 48px;">✅</p><p>WhatsApp Terhubung!</p>';
            statusEl.textContent = 'Terhubung';
            statusEl.className = 'status connected';
            btnBroadcast.disabled = false;
            addLog('Bot siap digunakan!', 'log-success');
        });
        
        socket.on('loading', (data) => {
            statusEl.textContent = 'Loading ' + data.percent + '%';
        });
        
        socket.on('stats', (data) => {
            totalEl.textContent = data.total;
            sentEl.textContent = data.sent;
            remainingEl.textContent = data.remaining;
            failedEl.textContent = data.failed || 0;
            if (data.message) {
                messageEl.value = data.message;
            }
        });
        
        socket.on('broadcast-progress', (data) => {
            progressContainer.style.display = 'block';
            progressText.style.display = 'block';
            const percent = Math.round((data.current / data.total) * 100);
            progressFill.style.width = percent + '%';
            progressText.textContent = data.current + '/' + data.total + ' - ✅ ' + data.success + ' | ❌ ' + data.fail;
        });
        
        socket.on('broadcast-done', (data) => {
            addLog('Broadcast selesai! ✅ ' + data.success + ' | ❌ ' + data.fail, 'log-success');
            btnBroadcast.disabled = false;
            btnBroadcast.textContent = '🚀 Mulai Broadcast';
            socket.emit('get-stats');
        });
        
        socket.on('message-saved', () => {
            addLog('Pesan broadcast disimpan!', 'log-success');
            alert('✅ Pesan broadcast disimpan!');
        });
        
        socket.on('broadcast-error', (msg) => {
            addLog('Error: ' + msg, 'log-error');
            alert('❌ ' + msg);
            btnBroadcast.disabled = false;
            btnBroadcast.textContent = '🚀 Mulai Broadcast';
        });
        
        // Button handlers
        btnSave.onclick = () => {
            const message = messageEl.value.trim();
            if (!message) {
                alert('Pesan tidak boleh kosong!');
                return;
            }
            socket.emit('set-message', message);
        };
        
        btnBroadcast.onclick = () => {
            if (!messageEl.value.trim()) {
                alert('Set pesan dulu!');
                return;
            }
            if (confirm('Mulai broadcast ke semua nomor?')) {
                btnBroadcast.disabled = true;
                btnBroadcast.textContent = '⏳ Broadcasting...';
                socket.emit('start-broadcast');
                addLog('Memulai broadcast...', 'log-warning');
            }
        };
        
        btnReset.onclick = () => {
            if (confirm('Reset data broadcast? Semua nomor akan bisa dikirim ulang.')) {
                socket.emit('reset-broadcast');
                addLog('Data broadcast di-reset', 'log-warning');
            }
        };
        
        // Get initial stats
        socket.emit('get-stats');
        setInterval(() => socket.emit('get-stats'), 5000);
    </script>
</body>
</html>
    `);
});

// Socket.IO handlers
io.on('connection', (socket) => {
    console.log('📱 Dashboard terhubung');
    
    // Send current QR if available
    if (currentQR) {
        socket.emit('qr', currentQR);
    }
    
    // Send ready status if already connected
    if (isReady) {
        socket.emit('ready');
    }
    
    // Get stats
    socket.on('get-stats', () => {
        const remaining = Array.from(uniqueNumbers).filter(n => !sentNumbers.has(n)).length;
        socket.emit('stats', {
            total: uniqueNumbers.size,
            sent: sentNumbers.size,
            remaining: remaining,
            message: broadcastMessage
        });
    });
    
    // Set message
    socket.on('set-message', (message) => {
        saveBroadcastMessage(message);
        socket.emit('message-saved');
        console.log('📝 Pesan broadcast diupdate via dashboard');
    });
    
    // Start broadcast
    socket.on('start-broadcast', async () => {
        if (!isReady) {
            socket.emit('broadcast-error', 'WhatsApp belum terhubung!');
            return;
        }
        if (isBroadcasting) {
            socket.emit('broadcast-error', 'Broadcast sedang berjalan!');
            return;
        }
        if (!broadcastMessage) {
            socket.emit('broadcast-error', 'Set pesan dulu!');
            return;
        }
        startBroadcast();
    });
    
    // Reset broadcast
    socket.on('reset-broadcast', () => {
        sentNumbers.clear();
        fs.writeFileSync(SENT_FILE, '');
        socket.emit('stats', {
            total: uniqueNumbers.size,
            sent: 0,
            remaining: uniqueNumbers.size,
            message: broadcastMessage
        });
    });
});

// ==========================================
// AUTO RESTART & ERROR HANDLING
// ==========================================
let restartCount = 0;
const MAX_RESTART = 10;
const RESTART_DELAY = 10000; // 10 detik

async function restartBot() {
    if (restartCount >= MAX_RESTART) {
        console.log('❌ Sudah restart terlalu banyak! Manual restart diperlukan.');
        return;
    }
    
    restartCount++;
    console.log(`🔄 Auto restart (${restartCount}/${MAX_RESTART}) dalam 10 detik...`);
    
    // Destroy client lama jika ada
    try {
        if (client) {
            await client.destroy();
        }
    } catch(e) {
        console.log('⚠️ Error destroy client:', e.message);
    }
    
    // Reset state
    isReady = false;
    isBroadcasting = false;
    client = null;
    
    // Tunggu dan restart
    await sleep(RESTART_DELAY);
    console.log('🚀 Memulai ulang bot...');
    initializeClient();
}

// Handle uncaught exception (crash)
process.on('uncaughtException', async (err) => {
    console.error('💥 CRASH ERROR:', err.message);
    log('💥 CRASH: ' + err.message);
    await restartBot();
});

// Handle unhandled promise rejection
process.on('unhandledRejection', async (reason, promise) => {
    console.error('💥 UNHANDLED REJECTION:', reason);
    log('💥 REJECTION: ' + reason);
    // Tidak restart untuk rejection, hanya log
});

// ==========================================
// MAIN
// ==========================================
console.log('');
console.log('🚀 WhatsApp Bot - Extractor + Broadcast');
console.log('========================================');
console.log('');

// Load data
loadExistingNumbers();
loadSentNumbers();
loadBroadcastMessage();

// Start web server
server.listen(WEB_PORT, () => {
    console.log(`🌐 Dashboard: http://localhost:${WEB_PORT}`);
    console.log('');
});

// Start WhatsApp
initializeClient();

// Reset restart count setiap 1 jam jika berjalan normal
setInterval(() => {
    if (isReady && restartCount > 0) {
        restartCount = 0;
        console.log('✅ Reset restart counter (bot stabil)');
    }
}, 3600000); // 1 jam

// Handle exit
process.on('SIGINT', async () => {
    console.log('\n👋 Menutup bot...');
    console.log(`📊 Total nomor: ${uniqueNumbers.size}`);
    if (client) await client.destroy();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n👋 SIGTERM received, menutup bot...');
    if (client) await client.destroy();
    process.exit(0);
});
