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
		this.objectsTemplates = JSON.parse(fs.readFileSync(__dirname + '/lib/objects_templates.json', 'utf8'));
		// holds alls data from the gvl files in the directory
		this.nvlFileBase = {};

		// if set to false in initialisation process the adapter will be terminated before the network socket is bound
		this.configurationOk= true;
		this.gvlInfo = [];				// part of this.config to extend the configuration object after gvl file loading
		this.idsToCreate = {};			// all list ids which have to be created. If id extists in db then delete before creation

		// creating a udp server
		this.server = udp.createSocket('udp4');
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		// Initialize your adapter here

		// Reset the connection indicator during startup
		this.setState("info.connection", false, true);

		// emits when any error occurs
		this.server.on('error', this.onServerError.bind(this));

		// emits when socket is ready and listening for datagram msgs
		this.server.on('listening', this.onServerListening.bind(this));

		// emits after the socket is closed using socket.close();
		this.server.on('close', this.onServerClose.bind(this));

		// emits on new datagram msg
		this.server.on('message', this.onServerMessage.bind(this));

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
			this.log.info('Codesys-NVL bind UDP socket to: "' + this.config.bind + ':' + this.config.port + '"');
			this.server.bind(this.config.port, this.config.bind);
		}
	}

    // Methods related to Server events
    /**
     * Is called if a server error occurs
     * @param {any} error
     */
    onServerError(error) {
        this.log.error('Server got Error: <' + error + '> closing server.');
        // Reset the connection indicator
        this.setState('info.connection', false, true);
        this.server.close();
    }

    /**
     * Is called when the server is ready to process traffic
     */
    onServerListening() {
        const addr = this.server.address();
        this.log.info('Codesys-NVL server ready on <' + addr.address + '> port <' + addr.port + '> proto <' + addr.family + '>');

        // Set the connection indicator after server goes for listening
        this.setState('info.connection', true, true);
    }

    /**
     * Is called when the server is closed via server.close
     */
    onServerClose() {
        this.log.info('Codesys-NVL server is closed');
    }

    /**
     * Is called on new datagram msg from server
     * @param {Buffer} msg      the message content received by the server socket
     * @param {Object} info     the info for e.g. address of sending host
     */
    async onServerMessage(msg, info) {
        try {
            const msg_hex = msg.toString('hex').toUpperCase();

			this.log.debug('-> ' + msg.length + ' bytes from ' + info.address + ':' + info.port + ': <' + this.logHexData(msg_hex) + '> org: <' + msg.toString() + '>');

		} catch (err) {
            this.errorHandler(err, 'onServerMessage');
        }
    }

    /**
     * Called on error situations and from catch blocks
	 * @param {any} err
	 * @param {string} module
	 */
	errorHandler(err, module = '') {
		this.log.error(`Codesys-NVL error in method: [${module}] error: ${err.message}, stack: ${err.stack}`);
	}
	
	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			// Here you must clear all timeouts or intervals that may still be active
			// clearTimeout(timeout1);
			// clearTimeout(timeout2);
			// ...
			// clearInterval(interval1);

            // Reset the connection indicator
            this.setState('info.connection', false, true);

			// close the server port
			this.server.close(callback);

			callback();
		} catch (e) {
			callback();
		}
	}

	/**
	 * Is called if a subscribed state changes
	 * @param {string} id
	 * @param {ioBroker.State | null | undefined} state
	 */
	onStateChange(id, state) {
		if (state) {
			// The state was changed
			this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
		} else {
			// The state was deleted
			this.log.info(`state ${id} deleted`);
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
							this.gvlInfo.push(configEntry);										//remember unchanged file item, no configDirty for now
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
				await this.extendObjectAsync('nvl.' + locObj._id, locObj);
				// now create the variable lists
				const gvlStructure = this.gvlInfo.find(x => x.ListIdentifier == key).gvlStructure;
				for (const element of this.objectsTemplates.nvls) {
					await this.extendObjectAsync(`nvl.${key}.${element._id}`, element);
					if (element._id !== 'var') {;
						for (const subelement of this.objectsTemplates[element._id]) {		// iterate through sub elements
							await this.extendObjectAsync(`nvl.${key}.${element._id}.${subelement._id}`, subelement);
							if (subelement._id === 'structure') {
								await this.setStateAsync(`nvl.${key}.${element._id}.${subelement._id}`, JSON.stringify(gvlStructure), true);
							}
						}
					} else {
						// and now populate the var part
						for (const actVarName in gvlStructure.children) {
							//this.log.debug(`actVarName: ${actVarName}`);
							switch (gvlStructure.children[actVarName].type) {
								case 'BOOL':
									this.createChannelTypeVar(key, actVarName, gvlStructure.children[actVarName].type);
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
     * create a channel type variable
	 * @param {string} listId listIdentifier
	 * @param {string} varName name of the variable to create
	 * @param {string} varType type of the variable to create
     */
    async createChannelTypeVar(listId = '0', varName = '', varType = 'BOOL') {
		try {
			if (this.objectsTemplates[varType] === undefined) {
				this.log.error(`unknown variable type: ${varType}. Giving up`);
				this.configurationOk = false;
				return;
			}
			await this.extendObjectAsync(`nvl.${listId}.var.${varName}`, this.objectsTemplates.channel);
			for (const element of this.objectsTemplates[varType]) {
				await this.extendObjectAsync(`nvl.${listId}.var.${varName}.${element._id}`, element);
			}
		} catch (err) {
			this.configurationOk = false;
			this.errorHandler(err, 'createChannelTypeVar');
		}
	}

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
