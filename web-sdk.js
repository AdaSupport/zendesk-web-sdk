import Sentry from "services/sentry";
import { api } from "services/http";
import moment from "moment-timezone";
import {
  getMemberType,
  getId,
  memberData,
  shouldFail,
  sendError
} from "libraries/zendesk";
import {
  LIVE_AGENT_API_ENDPOINT,
  ZENDESK_SESSION_ID
} from "services/constants";
import { storage, safeLocalStorage } from "services/storage";
import { promiseTimeout } from "services/promise";
import {
  ZENDESK_FILE_UPLOAD_ERROR,
  ZENDESK_FILE_UPLOAD_SUCCESS,
  START_FILE_UPLOAD,
  END_FILE_UPLOAD
} from "constants/actions";
import {
  SUPPORTED_MIME_TYPES,
  INVALID_EXTENSION,
  CHAT_QUEUE_POSITION,
  LAST_READ,
  CHAT_MSG,
  CHAT_FILE,
  CHAT_MEMBERJOIN,
  CHAT_MEMBERLEAVE,
  TYPING,
  LIVE_AGENT_REQUEST_PROCESSED,
  LIVE_AGENT_CLOSED_HANDOFF_FAIL,
  LIVE_AGENT_CLOSED_UNAVAILABLE,
  LIVE_AGENT_CLOSED_SUCCESS,
  INIT_PROMISE_TIMEOUT,
  EVENT_TYPES
} from "constants/zendesk";
import { DOWNLOADABLE_MESSAGE } from "constants/message-types";
import { sendToEmbed, isSameSession } from "libraries/chat";
import { mongoObjectId } from "services/objectid";
import { serializeError } from "services/errorTracker";

let zChatInstance = null;
let zChatConnected = null;
let zChatConnecting = null;
let zChatEventsBound = null;
let chatSessionID = null;
let zdSessionID = null;
let convoLastRead = null;
const initPromises = {};

/**
 * Returns whether we are connected to the Zendesk WebSDK.
 * @returns {Boolean} connected status.
 */
export function isConnected() {
  return zChatConnected;
}

/**
 * Returns whether we are still waiting for initSDK()'s Promise to resolve
 * @returns {Boolean} connected status.
 */
export function isConnecting() {
  return zChatConnecting;
}

/**
 * Returns whether we registered callbacks already.
 * @returns {Boolean} connected status.
 */
export function isBound() {
  return zChatEventsBound;
}

/**
 * Returns if the event should be processed
 * @param {Object} eventTime
 * @returns {Boolean} timestamp of the event
 */
function shouldProcessEvent(eventTime) {
  return isConnected() || (
    isConnecting() && (
      !convoLastRead ||
      (convoLastRead < eventTime)
    )
  );
}

/**
 * Returns if the event is executed by an agent and if should be processed
 * @param {String} memberType Who executed the event
 * @param {Object} eventTime timestamp of the event
 * @returns {Boolean}
 */
function shouldProcessAgentEvent(memberType, eventTime) {
  return memberType === "agent" && shouldProcessEvent(eventTime);
}

/**
 * Sends data to API so it can send to a monitoring service
 * @param {String} chatterId
 * @param {String} event
 */
function addMonitoring(chatterId, event) {
  api.post(`${LIVE_AGENT_API_ENDPOINT}monitor/`, {
    by: chatterId,
    event
  });
}

/**
 * Sends log information to API so it can write to logDNA
 * @param {String} chatterId
 * @param {String} functionCall
 * @param {Object} logData
 * @param {String} level Log level
 */
export function addLog(chatterId, functionCall, logData = null, level) {
  api.post(`${LIVE_AGENT_API_ENDPOINT}log/`, {
    function_call: functionCall,
    log_data: logData,
    by: chatterId,
    chat_session: chatSessionID,
    zd_session: zdSessionID,
    log_level: level
  });
}

/**
 * Makes a request to api with disconnected event data
 * @param {String} chatterId Ada chatter token
 * @param {Object|String} logData log data
 */
export function sendDisconnected(chatterId, logData) {
  api.post(LIVE_AGENT_API_ENDPOINT, {
    type: "live_chat_disconnected",
    by: chatterId,
    chat_session: chatSessionID,
    zd_session: zdSessionID
  });

  addLog(chatterId, "sendDisconnected", logData);

  addMonitoring(chatterId, LIVE_AGENT_CLOSED_HANDOFF_FAIL);
}

/**
 * EndChat on Zendesk, and clear stored account key
 */
export function endChatOnZendesk() {
  zChatInstance.endChat();
}

/**
 * Makes a request to api with session closed event data
 * @param {String} chatterId Ada chatter token
 */
export function sendSessionRefresh(chatterId) {
  api.post(LIVE_AGENT_API_ENDPOINT, {
    type: "live_chat_session_refresh",
    by: chatterId,
    chat_session: chatSessionID,
    zd_session: zdSessionID
  });
}

/**
 * Makes a request to api with live chat initalization failure
 * event data.
 * @param {String} chatterId Ada chatter token
 * @param {String} event name of the event where issue arrised
 * @param {Object} err error
 */
export function sendInitFailure(chatterId, event, err = null) {
  api.post(LIVE_AGENT_API_ENDPOINT, {
    type: "live_chat_init_failure",
    by: chatterId,
    chat_session: chatSessionID,
    zd_session: zdSessionID
  });

  addLog(chatterId, event, err, "warning");
}

/**
 * Sends chatter message to Zendesk
 * @param {Object} response
 * @param {String} chatterId Ada chatter token
 */
export function sendMessage(response, chatterId) {
  const { message } = response;
  const messageHash = JSON.stringify(response);
  const lastMessageHash = storage.retrieve("zendeskLastMessageHash");

  if (messageHash === lastMessageHash) {
    return;
  }

  zChatInstance.sendChatMsg(message, (err) => {
    if (err) {
      const logData = {
        event: "sendMessage",
        err
      };
      sendError(err);
      sendDisconnected(chatterId, logData);
    }
  });

  addLog(chatterId, "zChatInstance.sendChatMsg");

  storage.store("zendeskLastMessageHash", messageHash);
}

/**
 * @param {Object} store
 * @param {File} file
 */
export function sendFile(store, file) {
  const chatterId = store.getState().chatter.get("id");

  store.dispatch({
    type: START_FILE_UPLOAD
  });

  if (!SUPPORTED_MIME_TYPES.includes(file.type)) {
    store.dispatch({
      type: ZENDESK_FILE_UPLOAD_ERROR,
      errorKey: INVALID_EXTENSION,
      file
    });
    addLog(chatterId, "zChatInstance.sendFile", {
      event: INVALID_EXTENSION,
      mimeType: file.type
    });

    return;
  }

  zChatInstance.sendFile(file, (error, data) => {
    if (error) {
      store.dispatch({
        type: ZENDESK_FILE_UPLOAD_ERROR,
        errorKey: error.message,
        file
      });
      sendError(error);
      addLog(chatterId, "zChatInstance.sendFile", {
        event: ZENDESK_FILE_UPLOAD_ERROR,
        error: error.message,
        mimeType: file.type
      });
    } else {
      store.dispatch({
        type: "ADD_MESSAGE",
        messageType: DOWNLOADABLE_MESSAGE,
        mimeType: data.mime_type,
        url: data.url,
        name: data.name,
        isTransferingFile: false,
        inState: store.getState().pageState.get("inState"),
        clientToken: store.getState().chatter.get("clientToken"),
        tempMessageUuid: mongoObjectId()
      });
      store.dispatch({
        type: END_FILE_UPLOAD
      });
      addLog(chatterId, "zChatInstance.sendFile", {
        event: ZENDESK_FILE_UPLOAD_SUCCESS
      });
    }
  });
}

/**
 * Makes a request to api with end chat event data
 * @param {String} chatterId Ada chatter token
 * @param {Number} timestamp Zendesk server timestamp in ms
 */
export function sendEndChat(chatterId, timestamp) {
  api.post(LIVE_AGENT_API_ENDPOINT, {
    type: "live_chat_end_conversation",
    by: chatterId,
    timestamp,
    chat_session: chatSessionID,
    zd_session: zdSessionID
  });

  addLog(chatterId, "zChatInstance.endChat");

  addMonitoring(chatterId, LIVE_AGENT_CLOSED_SUCCESS);
}

/**
 * Cancel Zendesk conversation
 * @param {Object} store
 */
export function cancelChat(store) {
  endChatOnZendesk();

  addLog(store.getState().chatter.get("id"), "cancelChat");
}

/**
 * Calculate if the current time is within the hours of operations (HOO) set for a
 * Zendesk account or department.
 * @param {String} timezone of Zendesk HOO schedule
 * @param {String} zendeskSchedule of Zendesk department
 * @returns {Boolean} whether we are in HOO or not
 */
function isInHOOTime(timezone, zendeskSchedule) {
  if (!zendeskSchedule) {
    return false;
  }

  const currentTime = moment().tz(timezone);
  const midnightTime = moment().tz(timezone).startOf("day");
  const minSinceMidnight = currentTime.diff(midnightTime, "minutes", true);
  const dateOfWeek = currentTime.day();
  const daySchedule = zendeskSchedule[dateOfWeek];

  if (daySchedule.length === 0) {
    return false;
  }

  let inHOO = false;

  for (const schedule of daySchedule) {
    const dayStart = schedule.start;
    const dayEnd = schedule.end;

    inHOO = inHOO || (minSinceMidnight >= dayStart && minSinceMidnight <= dayEnd);
  }

  return inHOO;
}

/**
 * Helper function to calculate if the current time is within the hours of operations
 * (HOO) set for a Zendesk account or department.
 * @param {String} departmentId of Zendesk department
 * @returns {Boolean} whether we are in HOO or not
 */
function isInHOO(departmentId) {
  const operatingHours = zChatInstance.getOperatingHours();

  if (!operatingHours || !operatingHours.enabled) {
    return true;
  }

  let zendeskSchedule = null;

  if (operatingHours.type === "department") {
    zendeskSchedule = operatingHours.department_schedule[departmentId];
  } else {
    zendeskSchedule = operatingHours.account_schedule;
  }

  return isInHOOTime(operatingHours.timezone, zendeskSchedule);
}

/**
 * Checks if zendesk's visitor name is a default generated one
 * @param {String} visitorName name on Zendesk, i.e. Visitor 1234567
 * @returns {Boolean}
 */
function zendeskNameIsDefault(visitorName) {
  const defaultNameRegex = /Visitor \d*/g;

  return defaultNameRegex.test(visitorName);
}

/**
 * Build object with name and email about the chatter
 * @param {String} chatterName Ada chatter's name or null
 * @param {String} chatterEmail Ada chatter's email or null
 * @returns {Object} visitorInfo
 */
function buildVisitorInfo(chatterName, chatterEmail) {
  let visitorInfo = {};

  const {
    display_name: zendeskName, // string
    email: zendeskEmail// string or null
  } = zChatInstance.getVisitorInfo();

  if (zendeskNameIsDefault(zendeskName) && chatterName) {
    // if zendesk's chatter name is their default,
    // and variable for chatter is set on ada, replace
    visitorInfo = { display_name: chatterName };
  }

  if (!zendeskEmail && chatterEmail) {
    // if zendesk doesn't have an identified email,
    // and variable for chatter is set on ada, replace
    visitorInfo = {
      ...visitorInfo,
      email: chatterEmail
    };
  }

  return visitorInfo;
}

/**
 * @param {String} chatterId
 * @param {Object} payload
 * @returns {Promise}
 */
export function postChatAgentEvent(chatterId, payload) {
  return api.post(LIVE_AGENT_API_ENDPOINT, payload)
    .then(() => zChatInstance.markAsRead())
    .catch(err => addLog(
      chatterId, "Failed to send message to API", err, "warning"
    ));
}

/**
 * Sets visitor information and send transcript
 * @param {String} chatterName Ada chatter's name
 * @param {String} chatterEmail Ada chatter's email
 * @param {Array} chatterTranscript transcript
 * @param {String} chatterId Ada chatter token
 */
function initConversation(chatterName, chatterEmail, chatterTranscript, chatterId) {
  const visitorInfo = buildVisitorInfo(chatterName, chatterEmail);

  if (visitorInfo) {
    zChatInstance.setVisitorInfo(visitorInfo, (err) => {
      if (err) {
        sendError(err);
        sendInitFailure(chatterId, "setVisitorInfo", err);
      }
    });
  }

  // Send each line of transcript to Zendesk
  chatterTranscript.forEach((transcriptLine) => {
    zChatInstance.sendChatMsg(transcriptLine, (err) => {
      if (err) {
        sendError(err);
        sendInitFailure(chatterId, "sendChatMsg", err);
      }
    });
  });

  addLog(chatterId, "initConversation and zChatInstance.sendChatMsg", {
    visitor: visitorInfo,
    transcript: chatterTranscript.join(",")
  });

  addMonitoring(chatterId, LIVE_AGENT_REQUEST_PROCESSED);
}

/**
 * Applies callbacks on Zendesk SDK events
 * @param {String} chatterId Ada chatter token
 * @param {Object} store
 */
export function bindChatEventHandlers(chatterId, store) {
  if (isBound()) {
    return;
  }

  addLog(chatterId, "bindChatEventHandlers called");

  zChatInstance.on("chat", (eventData) => {
    const memberType = getMemberType(eventData.nick);
    const memberId = getId(eventData.nick);

    switch (eventData.type) {
      case CHAT_QUEUE_POSITION: {
        api.post(LIVE_AGENT_API_ENDPOINT, {
          type: "live_chat_queue_position",
          position: eventData.queue_position,
          by: chatterId,
          chat_session: chatSessionID,
          zd_session: zdSessionID
        });

        break;
      }

      case LAST_READ: {
        convoLastRead = eventData.timestamp;
        break;
      }

      case CHAT_MSG: {
        if (shouldProcessAgentEvent(memberType, eventData.timestamp)) {
          postChatAgentEvent(chatterId, {
            type: "live_chat_message",
            member: memberData(eventData),
            message: {
              msg: eventData.msg,
              timestamp: eventData.timestamp
            },
            by: chatterId,
            chat_session: chatSessionID,
            zd_session: zdSessionID
          });
        }

        break;
      }

      case CHAT_FILE: {
        if (shouldProcessAgentEvent(memberType, eventData.timestamp)) {
          const { mime_type, name, url } = eventData.attachment;

          postChatAgentEvent(chatterId, {
            type: "live_chat_file_message",
            member: memberData(eventData),
            message: {
              mimeType: mime_type,
              name,
              url,
              timestamp: eventData.timestamp
            },
            by: chatterId,
            chat_session: chatSessionID,
            zd_session: zdSessionID
          });
        }

        break;
      }

      case CHAT_MEMBERJOIN: {
        if (memberType === "agent") {
          store.dispatch({
            type: "ADD_ZENDESK_AGENT",
            id: memberId,
            timestamp: eventData.timestamp
          });
        }

        break;
      }

      case CHAT_MEMBERLEAVE: {
        const chatting = zChatInstance.isChatting();

        if (shouldProcessAgentEvent(memberType, eventData.timestamp)) {
          store.dispatch({
            type: "REMOVE_ZENDESK_AGENT",
            id: memberId
          });

          api.post(LIVE_AGENT_API_ENDPOINT, {
            type: "live_chat_presence_left",
            member: {
              type: memberType,
              display_name: eventData.display_name,
              agent_id: getId(eventData.nick)
            },
            by: chatterId,
            timestamp: eventData.timestamp,
            chat_session: chatSessionID,
            zd_session: zdSessionID
          })
            .then(() => zChatInstance.markAsRead())
            .catch(err => addLog(
              chatterId,
              "Failed to send live_chat_presence_left to API",
              err,
              "warning"
            ));
        }

        const noAgents = store.getState().liveAgentState
          .get("zendeskAgents").isEmpty();

        if (!chatting || noAgents) {
          sendEndChat(chatterId, eventData.timestamp);
        }

        break;
      }

      case TYPING: {
        if (memberType !== "agent") {
          break;
        }

        let typingEvent = "live_chat_typing_end";

        if (eventData.typing) {
          typingEvent = "live_chat_typing_start";
        }

        api.post(LIVE_AGENT_API_ENDPOINT, {
          type: typingEvent,
          member: {
            type: memberType,
            agent_id: getId(eventData.nick)
          },
          by: chatterId,
          chat_session: chatSessionID,
          zd_session: zdSessionID
        });

        break;
      }

      default:
    }
  });

  zChatInstance.on("agent_update", (eventData) => {
    const agentDisplayName = eventData.display_name;
    const agentId = getId(eventData.nick);
    const avatarPath = eventData.avatar_path;
    const timestamp = store.getState().liveAgentState.getIn([
      "zendeskAgents", agentId, "timestamp"
    ]);
    store.dispatch({
      type: "UPDATE_ZENDESK_AGENT",
      id: agentId,
      data: eventData
    });

    api.post(LIVE_AGENT_API_ENDPOINT, {
      type: "live_chat_presence",
      member: {
        type: "agent",
        display_name: agentDisplayName,
        agent_id: agentId,
        image_url: avatarPath
      },
      by: chatterId,
      timestamp,
      chat_session: chatSessionID,
      zd_session: zdSessionID
    });
  });

  zChatInstance.on("error", (eventData) => {
    sendError(eventData);
    const err = serializeError(eventData);
    addLog(
      chatterId,
      "Zendesk Error Event in bindChatEventHandlers",
      err,
      "warning"
    );

    if (shouldFail(eventData)) {
      const logData = {
        event: eventData.context,
        err
      };
      sendDisconnected(chatterId, logData);
    }
  });

  zChatEventsBound = true;
}

/**
 * Sends any tags that were added to the block
 * @param {Object} response Api websocket event data
 */
function sendTags(response) {
  const { tags } = response;

  if (tags) {
    tags.forEach((tag) => {
      zChatInstance.addTag(tag);
    });
  }
}

/**
 * Sets default department and check hours of operation in that queue
 * @param {String} chatterId Ada chatter token
 * @param {Object} response Api websocket event data
 */
export function setupConversation(chatterId, response) {
  const accountStatus = zChatInstance.getAccountStatus();
  const {
    display_name: chatterName,
    email: chatterEmail
  } = response.visitor_info;
  const {
    transcript: chatterTranscript,
    department_id: departmentId,
    check_dept_availability: checkDeptAvailability
  } = response;
  const departmentInfo = zChatInstance.getDepartment(parseInt(departmentId, 10));
  addLog(chatterId, "setupConversation", {
    agentsOnlineStatus: accountStatus,
    apiData: response
  });


  if (
    accountStatus === "offline" ||
    (checkDeptAvailability && departmentInfo.status === "offline")
  ) {
    sendInitFailure(chatterId, "offlineCheck", {
      accountStatus,
      checkDeptAvailability,
      deptAvailability: departmentInfo.status
    });

    addMonitoring(chatterId, LIVE_AGENT_CLOSED_UNAVAILABLE);

    return;
  }

  // Set chatter's default department
  if (departmentId) {
    zChatInstance.setVisitorDefaultDepartment(parseInt(departmentId, 10), (err) => {
      if (err) {
        sendError(err);
        sendInitFailure(chatterId, "setVisitorDefaultDepartment", err);

        return;
      }

      // Check for hours of operations
      if (!isInHOO(departmentId)) {
        api.post(LIVE_AGENT_API_ENDPOINT, {
          type: "live_chat_outside_hoo",
          by: chatterId,
          chat_session: chatSessionID,
          zd_session: zdSessionID
        });

        addMonitoring(chatterId, LIVE_AGENT_CLOSED_UNAVAILABLE);

        return;
      }

      initConversation(chatterName, chatterEmail, chatterTranscript, chatterId);
    });
  } else {
    initConversation(chatterName, chatterEmail, chatterTranscript, chatterId);
  }

  sendTags(response);
}

/**
 * Add breadcrumbs to Sentry for all ZD SDK Events we receive
 */
function bindLoggingEvents() {
  EVENT_TYPES.forEach((evt) => {
    zChatInstance.on(evt, (data) => {
      Sentry.addBreadcrumb({
        category: "zendesk-chat",
        message: "Zendesk SDK Event",
        data: {
          name: evt,
          eventData: data
        },
        level: Sentry.Severity.Info
      });
    });
  });
}

/**
 * Set the websocket debug function for the SDK
 * to use Sentry breadcrumbs
 */
function setWSDebugFunction() {
  window.zendeskStorage = {debug: (s) => console.log(s)}; return;
  window.zendeskStorage = Object.assign(
    {},
    window.zendeskStorage,
    {
      debug: msg => Sentry.addBreadcrumb({
        category: "zendesk-chat",
        message: "Zendesk SDK WS Debug",
        data: {
          msg
        },
        level: Sentry.Severity.Info
      })
    }
  );
}

/**
 * Import Zendesk WebSDK, initialize it with its account key
 * and return a promise that it has been initialized.
 *
 * @param {Object} response from API init chat event
 * @param {String} chatterId
 * @param {Object} store
 * @returns {Promise}
 */
export function initSDK(response, chatterId, store) {
  setWSDebugFunction();
  const accountKey = response.account_key;

  if (initPromises[accountKey]) {
    return initPromises[accountKey];
  }

  zChatConnecting = true;
  const initPromise = new Promise((resolve, reject) => {
    addLog(chatterId, "starting initSDK", {
      response
    });
    import(
      /* webpackChunkName: "zendesk-web-sdk" */
      /* webpackMode: "eager" */
      "./web-sdk"
    ).then((zChat) => {
      if (!isConnected()) {
        zChatInstance = zChat;
        bindLoggingEvents();
        bindChatEventHandlers(chatterId, store);
        zChat.init({ account_key: accountKey });

        zChat.on("connection_update", (status) => {
          addLog(chatterId, "initSDK on connection_update", status);

          switch (status) {
            case "connected":
              zChatConnected = true;
              zChatConnecting = false;

              // Send Zendesk Session (__zlcmid) to Embed to preserve
              zdSessionID = safeLocalStorage.getItem(ZENDESK_SESSION_ID);
              sendToEmbed({ zdSession: zdSessionID });
              resolve(zChat);
              break;

            case "connecting":
              break;

            case "closed":
              zChatConnected = false;
              zChatConnecting = false;
              reject(new Error(status));
              break;

            default:
              reject(new Error(status));
          }
        });
      }
    }).catch((err) => {
      sendError(err);
      const logData = {
        event: "Failed to load Zendesk SDK",
        err: serializeError(err)
      };
      sendDisconnected(chatterId, logData);
    });
  });

  initPromises[accountKey] = promiseTimeout(INIT_PROMISE_TIMEOUT, initPromise);

  return initPromises[accountKey];
}

/**
 * Starts Zendesk converstion.
 * If we need to call init on the Zendesk SDK, call it,
 * then run callback
 * @param {Object} store
 * @param {Object} response
 * @param {String} event the event calling the function
 * @param  {Function} callback function that's called after connecting
 */
function connectZD(store, response, event, callback) {
  const chatterId = store.getState().chatter.get("id");
  chatSessionID = store.getState().pageState.get("sessionID");

  if (isConnected()) {
    addLog(chatterId, event, {
      isConnected: "true",
      apiData: response
    });

    callback();
  } else if (!isConnecting()) {
    initSDK(response, chatterId, store).then(() => {
      addLog(chatterId, `initSDK from ${event}`, {
        isConnected: "false",
        apiData: response
      });

      callback();
    }).catch((err) => {
      const logData = {
        event: "connectZD",
        err: serializeError(err),
        connectionStatus: zChatInstance.getConnectionStatus()
      };
      sendError(err);
      sendDisconnected(chatterId, logData);
    });
  }
}

/**
 * Starts Zendesk converstion.
 * If we need to call init on the Zendesk SDK, call it,
 * then send visitor information according to websocket event.
 * If not, just send visitor information.
 * @param {Object} store
 * @param {Object} response
 */
export function initZendeskChat(store, response) {
  const chatterId = store.getState().chatter.get("id");
  const initializedSession = isSameSession(store, response.external_chat_id);

  connectZD(
    store, response, "initZendeskChat", () => {
      if (initializedSession) {
        setupConversation(chatterId, response);
      }
    }
  );
}

/**
 * Starts Zendesk converstion.
 * If we need to call init on the Zendesk SDK, call it,
 * then send visitor information according to websocket event.
 * If not, just send visitor information.
 * @param {Object} store
 * @param {Object} response
 */
export function reconnectZendeskChat(store, response) {
  const chatterId = store.getState().chatter.get("id");

  connectZD(
    store, response, "reconnectZendeskChat", () => {
      const position = zChatInstance.getQueuePosition();
      sendTags(response);

      if (position > 0) {
        api.post(LIVE_AGENT_API_ENDPOINT, {
          type: "live_chat_queue_position",
          by: chatterId,
          position,
          chat_session: chatSessionID,
          zd_session: zdSessionID
        });
      }
    }
  );
}

/**
 * Sends a single message to the Zendesk conversation.
 * If we need to call init on the Zendesk SDK, call it,
 * then send the chatter's new message.
 * If we have, just send the message.
 * @param {Object} store
 * @param {Object} response
 */
export function sendMessageToZendesk(store, response) {
  const chatterId = store.getState().chatter.get("id");
  const { transcript } = response;
  storage.store("chatterTranscript", transcript);

  connectZD(
    store, response, "sendMessageToZendesk", () => sendMessage(response, chatterId)
  );
}

/**
 * Send the chatter's typing event to Zendesk
 * @param {Boolean} isTyping
 */
export function sendTypingIndicatorToZendesk(isTyping) {
  if (isConnected()) {
    zChatInstance.sendTyping(isTyping);
  }
}
