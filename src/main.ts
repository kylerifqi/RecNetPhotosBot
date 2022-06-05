import { Message, TextChannel } from 'discord.js';
/* eslint-disable @typescript-eslint/no-non-null-assertion */
import axios from 'axios';
import { Client, GuildBasedChannel, Intents } from 'discord.js';
import path from 'path';
import { Database, open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { prefix, token } from './config.json';

const client = new Client({ intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES] });
let db: Database<sqlite3.Database, sqlite3.Statement>;

interface AccountData {
	accountId: number;
	username: string;
	displayName: string;
	profileImage: string;
	bannerImage: string;
	isJunior: boolean;
	platforms: number;
	createdAt: string;
}

interface ImageData {
	Id: number;
	Type: number;
	Accessibility: number;
	AccessibilityLocked: boolean;
	ImageName: string;
	Description: string | null;
	PlayerId: number;
	TaggedPlayerIds: number[];
	RoomId: number;
	PlayerEventId: number | null;
	CreatedAt: string;
	CheerCount: number;
	CommentCount: number;
	Author: DBProfile;
}

interface DBProfile {
	displayname: string;
	username: string;
	id: number;
	latest: number;
	guilds: string;
}

// eslint-disable-next-line no-console
const LOG = (msg: string) => console.log(`[${(new Date).toLocaleTimeString('it-MY')}]: ${msg}`);
const GET = async (url: string) => (await axios.get(url)).data;
const getPlayer = (username: string): Promise<AccountData> => GET(`https://accounts.rec.net/account?username=${username.toLowerCase()}`).catch(() => null);
const getImages = (accountId: number, amount = 15): Promise<ImageData[]> => GET(`https://api.rec.net/api/images/v4/player/${accountId}?take=${amount}`).catch(() => null);
const getAllDBProfiles = (): Promise<DBProfile[]> => db.all('SELECT * FROM profiles');
const getDBProfile = (username: string): Promise<DBProfile> => db.get('SELECT * FROM profiles WHERE username = ?', username).catch(() => null);
const getChannelID = async (guildID: string) => {
	const response = (await db.get('SELECT * FROM channel WHERE guild = ?', guildID).catch(() => null));
	if (response == undefined) return null;
	else return response.id;
};
const setChannelID = async (channelID: string, guildID: string) => {
	if (await db.get('SELECT 1 FROM channel WHERE guild = ?', guildID)) {
		db.run('UPDATE channel SET id = ? WHERE guild = ?', channelID, guildID);
	} else {
		db.run('INSERT INTO channel (id,guild) VALUES (?,?)', channelID, guildID);
	}
};

client.on('ready', async client => {
	LOG(`Logged in as ${client.user.tag}!`);

	client.user.setPresence({
		status: 'idle',
		activities: [
			{
				name: `${prefix}help`,
				type: 'LISTENING'
			}
		]
	});

	db = await open({
		filename: path.join(__dirname,'..','public','database.db'),
		driver: sqlite3.Database
	});

	setInterval(async () => {
		const _newPhotos = [];
		for (const profile of await getAllDBProfiles()) {
			const images = await getImages(profile.id);
			if (images.length < 1 || images[0].Id === profile.latest) continue;

			let i = 0;
			while (images[i].Id !== profile.latest) {
				images[i].Author = profile;
				_newPhotos.push(images[i]);
				i++;
			}

			db.run('UPDATE profiles SET latest = ? WHERE username = ?', images[0].Id, profile.username);
		}

		if (_newPhotos.length < 1) return;
		const newPhotos = _newPhotos.sort((a, b) => +(new Date(a.CreatedAt)) - +(new Date(b.CreatedAt)));

		LOG(`Found ${newPhotos.length} new photos that have been taken.`);

		for (const p of newPhotos) {
			for (const guildID of JSON.parse(p.Author.guilds)) {
				const channelID = await getChannelID(guildID);

				if (channelID == undefined) continue;

				const message = (client.channels.cache.get(channelID) as TextChannel).send(`https://img.rec.net/${p.ImageName}`);
				(await message).startThread({ name: `Taken By ${p.Author.displayname}`, });
			}
		}
	}, 300000);
});

client.on('messageCreate', async (msg) => {
	if (!msg.content.startsWith(prefix) || msg.author.bot) return;

	const args = msg.content.slice(prefix.length).trim().split(/ +/);
	const command = args.shift()!.toLowerCase();

	const guildID = msg.guild?.id || '';

	const verifyProfile = async (callback: (data: AccountData, ogmsg: Message) => void) => {
		const ogmsg = await msg.channel.send('Loading...');
		if (args.length < 1) ogmsg.edit('You need to include a username!');
		const data = await getPlayer(args[0]);
		if (data == null) ogmsg.edit('Username you entered does not exist!');
		callback(data, ogmsg);
	};

	if (command === 'profiles') {
		const channelID = await getChannelID(guildID);
		const profiles = (await db.all('SELECT * FROM profiles WHERE guilds LIKE ? ORDER BY displayname ASC', `%${guildID}%`));

		msg.channel.send({
			'embeds': [
				{
					'type': 'rich',
					'title': 'Profiles',
					'description': `*A list of profiles that the bot is subscribed to and channel new photos are sent to.*\n\n${profiles.length < 1 ? `**Not subscribed to any profiles, subscribe by doing** \`${prefix}subscribe <username>\`**!**` : profiles.map(x => `• **${x.displayname}** - *${x.username}*`).join('\n')}\n\n**New photos are sent to:** ${channelID == undefined ? `*Not set, add a channel using *\`${prefix}channel <#channel>\`*!*` : `<#${channelID}>`}\n\n*Find out more about a user by doing* \`${prefix}info <username>\`.`,
					'color': 0xee6528
				}
			]
		});
		LOG(`Sent a list of subscribed profiles to ${msg.member?.user.tag} in #${(msg.channel as GuildBasedChannel).name} > ${msg.guild?.name}`);
	} else if (command === 'subscribe') {
		verifyProfile(async (data, ogmsg) => {
			const profile = await getDBProfile(data.username);

			if (profile != undefined) {
				const inGuild = JSON.parse(profile.guilds).includes(guildID);
				if (inGuild) return ogmsg.edit('Already subscribed to profile! Did you mean to unsubscribe?');
				else if (!inGuild) await db.run('UPDATE profiles SET guilds = ? WHERE username = ?', JSON.stringify([...JSON.parse(profile.guilds), guildID]), data.username);
			} else {
				const latest = ((await getImages(data.accountId, 1))[0] || { Id: 0 }).Id;
				await db.run('INSERT INTO profiles (displayname,username,id,latest,guilds) VALUES (?,?,?,?,?)', data.displayName, data.username, data.accountId, latest, JSON.stringify([guildID]));
			}

			ogmsg.edit(`Added **${data.displayName}**, *${data.username}* to subscribed profiles. Use \`${prefix}info ${data.username}\` to find out more about this user.`);
			LOG(`Subscribed to user @${data.username} from #${(msg.channel as GuildBasedChannel).name} > ${msg.guild?.name}`);
		});
	} else if (command === 'unsubscribe') {
		verifyProfile(async (data, ogmsg) => {
			const profile = await getDBProfile(data.username);
			if (profile == null) return;
			const inGuild = JSON.parse(profile.guilds).includes(guildID);
			if (!inGuild) return ogmsg.edit('Not subscribed to profile! Did you mean to subscribe?');

			const newGuilds = JSON.parse(profile.guilds).filter((x: string) => x !== guildID);
			if (newGuilds.length < 1) await db.run('DELETE FROM profiles WHERE username = ?', data.username);
			else await db.run('UPDATE profiles SET guilds = ? WHERE username = ?', JSON.stringify(newGuilds), data.username);
			ogmsg.edit(`Unsubscribed from **${data.displayName}**, *${data.username}*. Use \`${prefix}about ${data.username}\` to find out more about this user.`);

			LOG(`Unsubscribed from user @${data.username} from #${(msg.channel as GuildBasedChannel).name} > ${msg.guild?.name}`);
		});
	} else if (command === 'info') {
		verifyProfile(async (data, ogmsg) => {
			const un = data.username;

			const _verified = GET(`https://api.rec.net/api/influencerpartnerprogram/isinfluencer?accountId=${data.accountId}`);
			const _bio = GET(`https://accounts.rec.net/account/${data.accountId}/bio`);
			const _subscribers = GET(`https://clubs.rec.net/subscription/subscriberCount/${data.accountId}`);

			const [verified, bio, subscribers] = (await Promise.all([_verified, _bio, _subscribers]));

			ogmsg.edit({
				'content': null,
				'embeds': [
					{
						'type': 'rich',
						'title': `${data.displayName}${verified ? ':ballot_box_with_check:' : ''}`,
						'description': `**Username**: ${un}\n**Subscribers:** ${subscribers}\n**Bio: **${bio.bio == null ? 'N/A' : `\n${bio.bio}`}\n\n**Account ID**: ${data.accountId}\n**Account Created**: ${new Date(data.createdAt).toDateString()}\n**Junior Account**: ${data.isJunior?'True':'False'}\n\n**Links:**\n[Photos](https://rec.net/user/${un}/photos)\n[Rooms](https://rec.net/user/${un}/rooms)\n[Events](https://rec.net/user/${un}/events)`,
						'color': 0xee6528,
						'image': {
							'url': `https://img.rec.net/${data.bannerImage}`,
						},
						'thumbnail': {
							'url': `https://img.rec.net/${data.profileImage}?cropSquare=true&width=192&height=192`,
							'height': 192,
							'width': 192
						},
						'url': `https://rec.net/user/${un}`
					}
				]
			});

			LOG(`Sent profile info of ${data.displayName} (${un}) response to ${msg.member?.user.tag} in #${(msg.channel as GuildBasedChannel).name} > ${msg.guild?.name}`);
		});
	} else if (command === 'channel') {
		if (!args[0]) {
			msg.channel.send(`You need to tag a channel or run \`${prefix}channel remove\`.`);
		} else if (args[0].toLowerCase().includes('remove')) {
			msg.channel.send('Removing channel for this server.');
			await db.run('DELETE FROM channel WHERE guild = ?', guildID);
		} else {
			const channelID = args[0].substring(2).substring(0,18);
			const channel = msg.guild!.channels.cache.get(channelID);
			if (channel == null) msg.channel.send(`You need to tag a channel or  \`${prefix}channel remove\`.`);
			else {
				setChannelID(channel.id, guildID);
				msg.channel.send(`<#${channel.id}> is now the channel new photos will be sent to in this server!`);
				LOG(`Channel has been changed to #${channel.name} > ${msg.guild?.name} by ${msg.member?.user.tag} in #${(msg.channel as GuildBasedChannel).name} > ${msg.guild?.name}`);
			}
		}
	} else if (command === 'help') {
		msg.channel.send({
			'embeds': [
				{
					'type': 'rich',
					'title': 'Help Command',
					'description': `• **About**\nThis bot will automatically upload photos taken by profiles that the bot is subscribed to. Find out what profiles the bot is subscribed to by doing \`${prefix}profiles\`.\n\n• **Profiles**\nA list of profiles that the bot is subscribed to and channel new photos are sent to.\n*Usage: \`${prefix}profiles\`*\n\n• **Channels**\nChange the channel that the bot sends new photos to. Writing remove instead of a channel will remove the current active channel.\n*Usage: \`${prefix}channel <#channel>/remove\`*\n\n• **Subscribe**\nSubscribe the bot to a profile.\n*Usage: \`${prefix}subscribe <username>\`*\n\n• **Unsubscribe**\nUnsubscribe the bot from a profile.\n*Usage: \`${prefix}unsubscribe <username>\`*\n\n• **Info**\nShow a detailed info screen about a user.\n*Usage: \`${prefix}info <username>\`*\n\n*Prefix: ${prefix}*`,
					'color': 0xee6528
				}
			]
		});
		LOG(`Sent help response to ${msg.member?.user.tag} in #${(msg.channel as GuildBasedChannel).name} > ${msg.guild?.name}`);
	}
});

client.login(token);