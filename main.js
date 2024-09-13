/**
 *
 *      iobroker CODESYS Network Variable List (NVL) Adapter
 * 
 * 		Created with @iobroker/create-adapter v2.3.0
 *
 *      Copyright (c) 2024, Bannsaenger <bannsaenger@gmx.de>
 *
 *      MIT License
 *
 */
"use strict";

const utils = require("@iobroker/adapter-core");

const fs = require('fs');
const udp = require('dgram');
const xmlHandler = require('fast-xml-parser');
const iec = require('iec-61131-3');

class CodesysNvl extends utils.Adapter {
	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	constructor(options) {
		super({
			...options,
			name: "codesys-nvl",
		});
		this.on("ready", this.onReady.bind(this));
		this.on("stateChange", this.onStateChange.bind(this));
		this.on("message", this.onMessage.bind(this));
		this.on("unload", this.onUnload.bind(this));

		// read Objects template for object generation
		this.objectsTemplates = JSON.parse(fs.readFileSync(__dirname + '/lib/object_templates.json', 'utf8'));
		// holds alls data from the gvl files in the directory
		this.nvlFileBase = {};

		// if set to false in initialisation process the adapter will be terminated before the network socket is bound
		this.configurationOk= true;
		this.gvlInfo = [];				// part of this.config to extend the configuration object after gvl file loading
		this.mainTimerInterval = 0;		// from config	
		this.idsToCreate = {};			// all list ids which have to be created. If id extists in db then delete before creation
		this.clientReady = false;		// true if data can be sent via the broadcast client connection

		// creating a udp server
		this.server = udp.createSocket({
			type: 'udp4',
			reuseAddr: true,
		});
		// creating a udp client (to send the broadcast to)
		this.client = udp.createSocket({
			type: 'udp4',
			reuseAddr: true,
		});
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		// Initialize your adapter here
		// Reset the connection indicator during startup
		this.setState("info.connection", false, true);
		// emitted server events
		this.server.on('error', this.onServerError.bind(this));
		this.server.on('listening', this.onServerListening.bind(this));
		this.server.on('close', this.onServerClose.bind(this));
		this.server.on('message', this.onServerMessage.bind(this));
		// emitted client events
		this.client.on('error', this.onClientError.bind(this));
		this.client.on('listening', this.onClientListening.bind(this));
		this.client.on('close', this.onClientClose.bind(this));

		// prepare the directory for the user to drop his gvl files
		await this.writeFileAsync(this.namespace, 'please_drop_your_gvl_files_here.txt', 'This file has no content');
		// load gvl file content
		await this.loadGvlFiles();

		if (this.configurationOk !== true) {
			this.log.error(`Codesys-NVL configuration invalid, exiting adapter`);
			if (typeof this.terminate === 'function') {
				this.terminate(utils.EXIT_CODES.INVALID_ADAPTER_CONFIG);
			} else {
				process.exit(utils.EXIT_CODES.INVALID_ADAPTER_CONFIG);
			}			
		} else {
			// The adapters config (in the instance object everything under the attribute "native") is accessible via
			// this.config:

			// In order to get state updates, you need to subscribe to them. The following line adds a subscription for our variable we have created above.
			// Or, if you really must, you can also watch all states. Don't do this if you don't need to. Otherwise this will cause a lot of unnecessary load on the system:
			this.subscribeStates('*');

			// try to open open configured server port
			// @ts-ignore
			this.log.info(`Codesys-NVL bind UDP socket to: <${this.config.bind}:${this.config.port}>`);
			// @ts-ignore
			this.server.bind(this.config.port, '0.0.0.0');
			// @ts-ignore
			this.client.bind(0, this.config.bind);
			// @ts-ignore
			this.mainTimerInterval = this.config.mainTimerInterval;
			// @ts-ignore
			for (const gvlInfo of this.config.gvlInfo) {
				if (gvlInfo.type === 'disabled') continue;										// skip disabled NVLs
				if (gvlInfo.type === 'send') {
					gvlInfo.nextSend = Math.floor(Math.random() * 10);							// for the first telegram sending
				}
				//gvlInfo.aktMinGap = Math.floor(gvlInfo.MinGap / this.mainTimerInterval) + 1;	// because this interval is mostly short enough
				gvlInfo.aktMinGap = 0;				// if > 0 we have to wait for the gap to pass by
				gvlInfo.dirtyAfterGap = true;		// if there was a try to send a telegram in the gap, send ist after gap passes by
				gvlInfo.aktWatchActive = 0;			// for receive lists. If > 0 we wait for a new telegram to receive. 0 after decrement set connection to false, 0 nothing to do for now
				gvlInfo.teleCounter = 1;			// Telegram counter. Initialize here and increment ist on telegram sending
				this.gvlInfo.push(gvlInfo);			// put the gvlInfo to the acrive NVLs
			}
			this.mainTimer = this.setInterval(this.onMainTimerInterval.bind(this), this.mainTimerInterval);
			//this.log.debug(`${JSON.stringify(this.gvlInfo, undefined, 1)}`);
		}
	}

	/**
	 * Main Timer function, called every minimum resolution slice configured by adapter config
	 */
	async onMainTimerInterval() {
		try {
			for (const gvlItem of this.gvlInfo) {		// iterate through all active NVLs
				if (gvlItem.type === 'send') {			// NVLs to send
					if (gvlItem.aktMinGap > 0) {
						gvlItem.aktMinGap--;
						return;							// if minGap > 0 sending is blocked
					}
					if (gvlItem.dirtyAfterGap) {
						gvlItem.dirtyAfterGap = false;
						this.sendTelegram(Number(gvlItem.ListIdentifier));
						return;							// don't process the default sending interval
					}
					if (gvlItem.nextSend > 0) {
						gvlItem.nextSend--;
						if (gvlItem.nextSend <= 0) {
							this.sendTelegram(Number(gvlItem.ListIdentifier));
							gvlItem.nextSend = Math.floor(gvlItem.Interval / this.mainTimerInterval);
						}
					}
				}
				if (gvlItem.type === 'receive') {		// received NVLs
					if (gvlItem.aktWatchActive > 0) {
						gvlItem.aktWatchActive--;
						if (gvlItem.aktWatchActive === 0) {
							await this.setStateChangedAsync(`${this.namespace}.nvl.${gvlItem.ListIdentifier}.info.connection`, false, true);
						}
					}
				}
			}
		} catch (err) {
            this.errorHandler(err, 'onMainTimerInterval');
        }
	}

    /**********************************************************************************************
     * Methods related to Server events
     **********************************************************************************************/
    /* #region Server events */
    /**
     * Is called if a server error occurs
     * @param {any} error
     */
    onServerError(error) {
        this.log.error(`Codesys-NVL server got Error: ${error} closing socket`);
        // Reset the connection indicator
        this.setState('info.connection', false, true);
        this.server.close();
    }

    /**
     * Is called when the server is ready to process traffic
     */
    onServerListening() {
        const addr = this.server.address();
        this.log.info(`Codesys-NVL server ready on <${addr.address}> port <${addr.port}> proto <${addr.family}>`);
        // Set the connection indicator after server goes for listening
        this.setState('info.connection', true, true);
    }

    /**
     * Is called when the server is closed via server.close
     */
    onServerClose() {
        this.log.info('Codesys-NVL server is closed');
        // Reset the connection indicator
        this.setState('info.connection', false, true);
    }

    /**
     * Is called on new datagram msg from server
     * @param {Buffer} msg      the message content received by the server socket
     * @param {Object} info     the info for e.g. address of sending host
     */
    async onServerMessage(msg, info) {
        try {
            const msg_hex = msg.toString('hex').toUpperCase();
			this.log.debug(`-> ${msg.length} bytes from ${info.address}:${info.port}: <${this.logHexData(msg_hex)}> org: <${msg.toString()}>`);

            // Check if payload is buffer
            if (!Buffer.isBuffer(msg) || msg.length < 20){
                this.log.error('Payload is not a valid buffer.');
                return;
            }

            const telegram = {
                listId:     	msg.readUInt16LE(8),        // List Identifier
                subId:      	msg.readUInt16LE(10),       // SubIndex
                varSize:    	msg.readUInt16LE(12),       // Number of variables
                teleSize:   	msg.readUInt16LE(14),       // Total length of telegram (header+data)
                teleCounter:	msg.readUInt32LE(16)        // Send counter
            }
			this.log.debug(`listId: ${telegram.listId}, subId: ${telegram.subId}, varSize: ${telegram.varSize}, teleSize: ${telegram.teleSize}, teleCounter: ${telegram.teleCounter}`);

			// @ts-ignore
			if (info.address === this.config.bind) {
				this.log.debug(`Telegram from myself. Skip it`);
				return;
			}

			let listIdValid = false;
			let gvlItem = {};
			// @ts-ignore
			for (const gvlInfo of this.gvlInfo) {
				if (gvlInfo.ListIdentifier === telegram.listId) {		// found listId in config
					if (gvlInfo.type === 'disabled') {
						this.log.debug(`ListId: ${telegram.listId} is disabled. Skip it`);
						return;
					}
					if (gvlInfo.type === 'send') {
						this.log.warn(`ListId: ${telegram.listId} is configured to be sent not received. Skip it`);
						return;
					}
					listIdValid = true;
					gvlItem = gvlInfo;			// remember the found gvl list
				}
			}
			if (!listIdValid) {
				this.log.debug(`ListId: ${telegram.listId} is not configured`);
				return;
			}
			// now try to parse the values
            // Check if package is valid
            let err = null;
            let dataSize = msg.length - 20;
			//this.log.warn(`gvlItem: ${JSON.stringify(gvlItem, undefined, 1)}`);
            if( telegram.subId >= gvlItem.gvlStructure.byteLength){
                err = new Error(`Telegram has a subIndex higher than expected: ${telegram.subId}`);
            } else if ( telegram.teleSize !== msg.length ){
                err = new Error(`Telegram size (${msg.length}B) is different than the value in the header (${telegram.teleSize} Byte).`);
            } /*else if ( dataSize !== nvl.packages[telegram.subId].byteSize ){
                err = new Error(`Telegram datasize doesn\'t match with nvl definition for subIndex ${telegram.subId}. Expected: ${nvl.packages[telegram.subId].byteSize}B Got: ${dataSize}B`);
            } add later when telegrams with sub ids were added*/

			//this.log.warn(`def: ${JSON.stringify(gvlItem.nvlDef, undefined, 1)}`);
			const nvl = iec.fromString(gvlItem.nvlDef, 'NVL');
			//let nvl = gvlItem.gvlStructure;
			//Object.setPrototypeOf(nvl, iec);
			//nvl.getDefault();
			const resNvl = nvl.convertFromBuffer(msg.subarray(20));
			//this.log.debug(`resNvl: ${JSON.stringify(resNvl, undefined, 1)}`);
			this.updateDatabaseAsync(Number(telegram.listId), gvlItem.gvlStructure.children, resNvl);
			await this.setStateChangedAsync(`${this.namespace}.nvl.${telegram.listId}.info.lastReceived`, Date.now(), true);
			await this.setStateChangedAsync(`${this.namespace}.nvl.${telegram.listId}.info.connection`, true, true);
			gvlItem.aktWatchActive = Math.floor((gvlItem.Interval / this.mainTimerInterval) * 2.5);

		} catch (err) {
            this.errorHandler(err, 'onServerMessage');
        }
    }
	/* #endregion */

    /**********************************************************************************************
     * Methods related to Client events
     **********************************************************************************************/
    /* #region Client events */
    /**
     * Is called if a client error occurs
     * @param {any} error
     */
    onClientError(error) {
        this.log.error(`Codesys-NVL broadcast sender got Error: ${error} closing socket`);
        // Reset the connection indicator
        this.setState('info.connection', false, true);
		this.clientReady = false;
        this.client.close();
    }

    /**
     * Is called when the client is ready to process traffic
     */
    onClientListening() {
        const addr = this.client.address();
        this.log.info(`Codesys-NVL broadcast sender ready on <${addr.address}> port <${addr.port}> proto <${addr.family}>`);
		this.client.setBroadcast(true);
		this.clientReady = true;
    }

    /**
     * Is called when the client is closed via client.close
     */
    onClientClose() {
        this.log.info('Codesys-NVL broadcast sender is closed');
        // Reset the connection indicator
        this.setState('info.connection', false, true);
		this.clientReady = false;
    }
	/* #endregion */

    /**********************************************************************************************
     * Methods related to instance events
     **********************************************************************************************/
    /* #region Instance events */
	/**
	 * Is called if a subscribed state changes
	 * @param {string} id
	 * @param {ioBroker.State | null | undefined} state
	 */
	onStateChange(id, state) {
		if (state) {
			this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
			if (!state.ack) {		// react only to commands
				const valueArray = id.split('.');
				// codesys-nvl.0.nvl.1.var.Watchdog1.value
				if (valueArray[2] === 'nvl' && valueArray[6] === 'value') {		// only if a value in a nvl has changed
					this.sendTelegram(Number(valueArray[3]));
				}
			}
		}
	}

	/**
	 * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
	 * Using this method requires "common.messagebox" property to be set to true in io-package.json
	 * @param {ioBroker.Message} obj
	 */
	onMessage(obj) {
		if (typeof obj === "object" && obj.message) {
			if (obj.command === "send") {
				// e.g. send email or pushover or whatever
				this.log.info("send command");

				// Send response in callback if required
				if (obj.callback) this.sendTo(obj.from, obj.command, "Message received", obj.callback);
			}
		}
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			// Clear main timerinterval
			clearInterval(this.mainTimer);

            // Reset the connection indicator
            this.setState('info.connection', false, true);

			// close the server and client port
			this.server.close();
			this.client.close();

			callback();
		} catch (e) {
			callback();
		}
	}
	/* #endregion */

    /**********************************************************************************************
     * Methods related to telegram handling
     **********************************************************************************************/
    /* #region Telegram handling */
	/**
	 * send a telegram, or part of it for the specified listId
	 * @param {Number} listId the ID of the NVL list to send
	 */
	async sendTelegram(listId) {
		try {
			if (!this.clientReady) {
				this.log.error(`sendTelegram: Client not ready. Abort sending for listId: ${listId}`);
				return;
			}
			const gvlItem = this.gvlInfo.find(x => x.ListIdentifier === listId);
			const gvlStructure = gvlItem.gvlStructure;
			if (!gvlItem) {
				this.log.error(`sendTelegram: listId: ${listId} not found`);
				return;
			}
			if (gvlItem.type !== 'send') return;		// disabled or receive list

			if (gvlItem.aktMinGap > 0) {	// wait for the min gap
				this.log.debug(`sendTelegram: must wait some timer cycles for telegram to send`);
				gvlItem.dirtyAfterGap = true;
				return;
			}

			// set new gap
			gvlItem.aktMinGap = Math.floor(gvlItem.MinGap / this.mainTimerInterval) + 1;	// because this interval is mostly short enough

			const varSize = Object.keys(gvlStructure.children).length;
			const nvl = iec.fromString(gvlItem.nvlDef, 'NVL');
			let data = nvl.getDefault();
			const statesToSend = await this.getStatesAsync(`${this.namespace}.nvl.${listId}.*`);
			for (const stateToSend of Object.entries(statesToSend)) {
				const valueArray = String(stateToSend[0]).split('.');
				if (valueArray[6] === undefined) continue;
				if (valueArray[6] !== 'value') continue;		// skip all but values
				let valueToSend = stateToSend[1].val;
				const variableToSend = valueArray[5];
				switch (gvlStructure.children[variableToSend].type) {
					case 'BOOL':
						data[variableToSend] = Boolean(valueToSend);
						break;

					case 'STRING':
						data[variableToSend] = String(valueToSend).substring(0, gvlStructure.children[variableToSend].byteLength - 1);		// shorten by 1 for trailing 0x0
						break;

					case 'WSTRING':
						data[variableToSend] = String(valueToSend).substring(0, (gvlStructure.children[variableToSend].byteLength / 2) - 1); // shorten by 1 for trailing 0x0 and half for 16 bit characters
						break;

					case 'INT':
						if (Number(valueToSend) > 32767) valueToSend = 32767;
						if (Number(valueToSend) < -32768) valueToSend = -32768;
						data[variableToSend] = Number(valueToSend);

					default:
						this.log.error(`dataType: ${gvlStructure.children[variableToSend].type} not implemented for sending`);
				}
			}
			//this.log.warn(`data: ${JSON.stringify(data, undefined, 1)}`);

			let sendBuf = nvl.convertToBuffer(data);						// Convert the values to a buffer

			// Build header
			let header = Buffer.alloc(20);
			header.write('\0-S3', 0, 4);                              		// Protocol identity code
			header.writeUInt16LE(listId, 8);                                // Index, COB-ID, listId, List Identifier
			header.writeUInt16LE(0, 10);                                    // SubIndex
			header.writeUInt16LE(varSize, 12);               				// Number of variables
			header.writeUInt16LE(gvlStructure.byteLength + 20, 14);         // Total length of telegram (header+data)
			header.writeUInt16LE(gvlItem.teleCounter, 16);              	// Send counter

			//Increment counter for next itteration
			gvlItem.teleCounter += 1;
			if(gvlItem.teleCounter > 65535){
				gvlItem.teleCounter = 0;
			}

			// Build full message and send
			// @ts-ignore
			this.client.send(Buffer.concat([header, sendBuf]), this.config.port, '255.255.255.255');

		} catch (err) {
            this.errorHandler(err, 'sendTelegram');
        }
	}
	/* #endregion */

    /**********************************************************************************************
     * Methods related to configuration and database creation and update
     **********************************************************************************************/
    /* #region configuration and database */
	/**
	 * load content of all gvl files
	 */
	async loadGvlFiles() {
        try {
			let gvlFileContent;
			let validationResult;
			let gvlFileXML;
			let configEntry = {};
			let configDirty = false;
			const XMLParser = new xmlHandler.XMLParser();
			const dataDir = `${utils.getAbsoluteDefaultDataDir()}files/${this.namespace}`;
			this.log.debug(`loading gvl files in directory: ${this.namespace}, realDir: ${dataDir}`);
			const dirContent = await this.readDirAsync(this.namespace, '/');
            for (let fileEntry of dirContent) {
				if (fileEntry.isDir) continue;								// Skip directorys
				if (fileEntry.file.split('.').pop() !== 'gvl') continue;	// skip not gvl files
				let fileName = fileEntry.file;
				this.log.debug(`Validating file "${fileName}"`);
				// read gvl file
				gvlFileContent = fs.readFileSync(`${dataDir}/${fileName}`, 'utf8');
				// gvlFileContent = await this.readFileAsync(this.namespace, fileName); tut leider nicht :(
				// validate gvl file
				validationResult = xmlHandler.XMLValidator.validate(gvlFileContent.toString());
				if (validationResult === true) {
					this.log.debug(`XML file "${fileName}" is valid. Try to load`);
					gvlFileXML = XMLParser.parse(gvlFileContent);
					if ((gvlFileXML.GVL.NetvarSettings.Pack !== undefined) && (gvlFileXML.GVL.NetvarSettings.Pack !== 'True')) {
						this.log.warn(`only "packed" nvl is supported. File ${fileName} is configured as unpacked or is invalid. Skip this gvl.`);
						continue;
					}
					fileName = fileName.replaceAll(' ', '_'); 									// for safety reasons
					// @ts-ignore
					configEntry = this.config.gvlInfo.find(x => x.fileName === fileName);		// if file was loaded before
					if (typeof(configEntry) === 'object') {
						// @ts-ignore
						if (gvlFileContent === String(configEntry.fileContent)) {				// skip loading if file content has not changed
							this.log.info(`File: ${fileName} is unchanged. Skip this file`);
							this.gvlInfo.push(configEntry);										// remember unchanged file item, no configDirty for now
							// @ts-ignore
							this.idsToCreate[configEntry.ListIdentifier] = {'fileName': configEntry.fileName, 'isDirty': false};
							continue;
						}
					} else {
						configEntry = {};
					}

					let localListId = gvlFileXML.GVL.NetvarSettings.ListIdentifier !== undefined ? Number(gvlFileXML.GVL.NetvarSettings.ListIdentifier) : 0;
					if (localListId === 0) {
						this.log.error(`Error in GVL-File: ${fileName}, ListId = 0 or undefined`);
						this.configurationOk = false;
						return;
					}
					if (this.idsToCreate[localListId] !== undefined) {
						this.log.error(`Error in GVL-Files. Double ListId ${localListId} in file: ${fileName} and ${this.idsToCreate[localListId].fileName}`);
						this.configurationOk = false;
						return;
					}
					this.idsToCreate[localListId] = {'fileName': fileName, 'isDirty': true};		// remember fileName for comparison and set this listId dirty for db creation
					// now parse the content
					configEntry.fileName = fileName;
					configEntry.ListIdentifier = localListId
					configEntry.type = 'disabled';					// if a new or changed file then disable the list in config
					configEntry.Pack = true;
					configEntry.Checksum = gvlFileXML.GVL.NetvarSettings.Checksum !== undefined ? (gvlFileXML.GVL.NetvarSettings.Checksum === 'True' ? true : false) : false;
					configEntry.Acknowledge = gvlFileXML.GVL.NetvarSettings.Acknowledge !== undefined ? (gvlFileXML.GVL.NetvarSettings.Acknowledge === 'True' ? true : false) : false;
					configEntry.CyclicTransmission = gvlFileXML.GVL.NetvarSettings.CyclicTransmission !== undefined ? (gvlFileXML.GVL.NetvarSettings.CyclicTransmission === 'True' ? true : false) : false;
					configEntry.TransmissionOnChange = gvlFileXML.GVL.NetvarSettings.TransmissionOnChange !== undefined ? (gvlFileXML.GVL.NetvarSettings.TransmissionOnChange === 'True' ? true : false) : false;
					configEntry.TransmissionOnEvent = gvlFileXML.GVL.NetvarSettings.TransmissionOnEvent !== undefined ? (gvlFileXML.GVL.NetvarSettings.TransmissionOnEvent === 'True' ? true : false) : false;
					configEntry.Interval = gvlFileXML.GVL.NetvarSettings.Interval !== undefined ? this.convertTimeString(gvlFileXML.GVL.NetvarSettings.Interval) : 1000;
					configEntry.MinGap = gvlFileXML.GVL.NetvarSettings.MinGap !== undefined ? this.convertTimeString(gvlFileXML.GVL.NetvarSettings.MinGap) : 100;
					configEntry.EventVariable = gvlFileXML.GVL.NetvarSettings.EventVariables !== undefined ? gvlFileXML.GVL.NetvarSettings.EventVariables : [];

					// Combine global datatypes with nvl definition
					let def = gvlFileXML.GVL.Declarations; // + "/r/n" + (datatypes || "");
					// Replace VAR_GLOBAL to NVL structure type
					let re = /VAR_GLOBAL(.+?)END_VAR/gms;
					def = def.replace( re, "TYPE NVL\:\r\nSTRUCT\r\n$1\r\nEND_STRUCT\r\nEND_TYPE");
					// Parse definition
					configEntry.gvlStructure = iec.fromString(def, 'NVL');
					configEntry.nvlDef = def;
					configEntry.fileContent = gvlFileContent;

					this.gvlInfo.push(configEntry);	
					configDirty = true;					// now we have a new part in the configuration

				} else if (validationResult.err) {
					this.log.warn(`XML is invalid because of - ${validationResult.err.msg}`);
					this.configurationOk = false;
					return;
				}
			}
			// create or delete the nvl database objects
			await this.createDatabaseAsync();

			if (configDirty) {
				this.log.info(`Configuration in files changed. Writing back config object and restart the adapter`);

                const instanceObject = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`) || {};
				// @ts-ignore
                instanceObject.native.gvlInfo = this.gvlInfo;
				// @ts-ignore
                await this.setForeignObjectAsync(`system.adapter.${this.namespace}`, instanceObject);
			}

			// reset object. Will be populated in onReady
			this.gvlInfo = [];

		} catch (err) {
			this.configurationOk = false;
            this.errorHandler(err, 'loadGvlFiles');
        }
	}

	/**
     * create the database (populate all values an delete unused)
     */
    async createDatabaseAsync() {
		try {
			this.log.info('Codesys-NVL start to create/update the database');

			this.log.debug('deleting unused and dirty nvls');

			// delete unused and dirty nvls
			for (const key in await this.getAdapterObjectsAsync()) {
				const tempArr = key.split('.');
				if (tempArr.length != 4) continue;
				if (tempArr[2] !== 'nvl') continue;
				if (this.idsToCreate[tempArr[3]] === undefined) {
					this.log.debug(`nvl with id = ${tempArr[3]} is no longer defined. Deleting`);
					await this.delObjectAsync(key, {recursive: true});
				} else if (this.idsToCreate[tempArr[3]].isDirty === true) {
					this.log.debug(`nvl with id = ${tempArr[3]} is redefined. Delete before new creation`);
					await this.delObjectAsync(key, {recursive: true});
				}
			}

			// create the nvls
			for (const key in this.idsToCreate) {
				let locObj = this.objectsTemplates.nvl;
				locObj._id = key;
				locObj.common.name = this.idsToCreate[key].fileName;
				await this.extendObject('nvl.' + locObj._id, locObj);
				// now create the variable lists
				const gvlStructure = this.gvlInfo.find(x => x.ListIdentifier == key).gvlStructure;
				for (const element of this.objectsTemplates.nvls) {
					await this.extendObject(`nvl.${key}.${element._id}`, element);
					if (element._id !== 'var') {;
						for (const subelement of this.objectsTemplates[element._id]) {		// iterate through sub elements
							await this.extendObject(`nvl.${key}.${element._id}.${subelement._id}`, subelement);
							if (subelement._id === 'structure') {
								await this.setState(`nvl.${key}.${element._id}.${subelement._id}`, JSON.stringify(gvlStructure), true);
							}
						}
					} else {
						// and now populate the var part
						for (const actVarName in gvlStructure.children) {
							//this.log.debug(`actVarName: ${actVarName}`);
							switch (gvlStructure.children[actVarName].type) {
								case 'BOOL':
								case 'STRING':
								case 'WSTRING':
								case 'INT':
									this.createChannelTypeVar(Number(key), actVarName, gvlStructure.children[actVarName].type);
									break;
							
								default:
									this.log.error(`Variable type: ${gvlStructure.children[actVarName].type} not supported for now. Sorry. Giving up ...`);
									this.configurationOk = false;
									return;
							}
						}
					}
				}
			}

			this.log.info('Codesys-NVL finished up database creation');
		} catch (err) {
			this.configurationOk = false;
			this.errorHandler(err, 'createDatabaseAsync');
		}
	}

	/**
     * update the database values (states)
	 * @param {Number} listId listIdentifier
	 * @param {object} structure a nvl structure
	 * @param {object} values the values to write to db
     */
    async updateDatabaseAsync(listId = 0, structure, values) {
		try {
			const baseId = `${this.namespace}.nvl.${listId}.var`;
			for (const key in structure) {		// iterate all possible values
				switch (structure[key].type) {
					case 'BOOL':
						//this.log.debug(`Set: ${baseId}.${key}.value to value: ${values[key]}`);
						await this.setStateChangedAsync(`${baseId}.${key}.value`, {val: Boolean(values[key]), ack: true});
						break;

					case 'STRING':
					case 'WSTRING':
						await this.setStateChangedAsync(`${baseId}.${key}.value`, {val: String(values[key]), ack: true});
						break;

					case 'INT':
						await this.setStateChangedAsync(`${baseId}.${key}.value`, {val: Number(values[key]), ack: true});
						break;

					default:
						this.log.error(`updateDatabaseAsync: variable type <${structure[key].type}> not implemented yet`);
				}
			}
		} catch (err) {
			this.errorHandler(err, 'updateDatabaseAsync');
		}
	}

	/**
     * create a channel type variable
	 * @param {Number} listId listIdentifier
	 * @param {string} varName name of the variable to create
	 * @param {string} varType type of the variable to create
     */
    async createChannelTypeVar(listId = 0, varName = '', varType = 'BOOL') {
		try {
			if (this.objectsTemplates[varType] === undefined) {
				this.log.error(`unknown variable type: ${varType}. Giving up`);
				this.configurationOk = false;
				return;
			}
			await this.extendObject(`nvl.${listId}.var.${varName}`, this.objectsTemplates.channel);
			for (const element of this.objectsTemplates[varType]) {
				await this.extendObject(`nvl.${listId}.var.${varName}.${element._id}`, element);
			}
		} catch (err) {
			this.configurationOk = false;
			this.errorHandler(err, 'createChannelTypeVar');
		}
	}

	/* #endregion #/

    /**********************************************************************************************
     * Other methods
     **********************************************************************************************/
	/* #region Other methods */
	/**
	 * format the given hex string to a byte separated form
	 * @param {string} locStr
	 * @returns {string} locStr in byte separated form
	 */
	logHexData(locStr) {
		let retStr = '';
		for (let i = 0; i < locStr.length; i += 2) {
			retStr += locStr.substring(i, i + 2) + ' ';
		}
		retStr = retStr.substring(0, retStr.length - 1);
		return retStr;
	}
	
	/**
	 * convert the given string to a number of milliseconds
	 * @param {string} timeStr TIME string
	 * @returns {number} TIME in ms
	 */
	convertTimeString(timeStr) {
		this.log.debug(`converting timestring: ${timeStr}`);
		let retTime = 0;
		let timeValue = 0;
		// e.g. T#100ms
		//timeStr = 'T#10s243ms';
		const regexTs = new RegExp(/[t|time]#(.*)/gi);
		const tsMatches = regexTs.exec(timeStr);
		//this.log.info(`ZeitTS: ${JSON.stringify(tsMatches, undefined, 2)}`);
		if (tsMatches === null || tsMatches.length !== 2) {
			this.log.error(`unable to convert timestring: ${timeStr}`);
			return 0;
		}
		const regexTv = new RegExp(/(\d+)(ms|s|m|h|d)/g);
		let tvMatches = regexTv.exec(tsMatches[1]);
		while (tvMatches != null) {
			//this.log.info(`ZeitTV: ${JSON.stringify(tvMatches, undefined, 2)}`);
			timeValue = Number(tvMatches[1] || 0);
			switch (tvMatches[2]) {
				case 'ms':
					retTime += timeValue;
					break;
				
				case 's':
					retTime += timeValue * 1000;
					break;

				case 'm':
					retTime += timeValue * 1000 * 60;
					break;

				case 'h':
					retTime += timeValue * 1000 * 60 * 60;
					break;

				case 'd':
					retTime += timeValue * 1000 * 60 * 60 * 24;
					break;

				default:
					this.log.error(`unknown character <${tvMatches[2]}> in time string <${timeStr}>`);
					return 0;
			}
			//this.log.debug(`actual time ${retTime}ms`);
			tvMatches = regexTv.exec(tsMatches[1]);
		}
		this.log.debug(`returning ${retTime}ms`);
		return retTime;
	}

	/**
     * Called on error situations and from catch blocks
	 * @param {any} err
	 * @param {string} module
	 */
	errorHandler(err, module = '') {
		this.log.error(`Codesys-NVL error in method: [${module}] error: ${err.message}, stack: ${err.stack}`);
	}
	/* #endregion */
}

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	module.exports = (options) => new CodesysNvl(options);
} else {
	// otherwise start the instance directly
	new CodesysNvl();
}
