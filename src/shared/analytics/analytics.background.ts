import { ethers } from 'ethers';
import type { Account } from 'src/background/account/Account';
import { emitter } from 'src/background/events';
import { networksStore } from 'src/modules/networks/networks-store.background';
import { INTERNAL_SYMBOL_CONTEXT } from 'src/background/Wallet/Wallet';
import { INTERNAL_ORIGIN } from 'src/background/constants';
import { getWalletNameFlagsChange } from 'src/background/Wallet/GlobalPreferences';
import {
  createParams as createBaseParams,
  sendToMetabase,
  onIdle,
} from './analytics';
import {
  createAddProviderHook,
  initialize as initializeApiV4Analytics,
} from './api-v4-zerion';
import {
  getProviderForApiV4,
  getProviderForMetabase,
  getProviderNameFromGroup,
} from './getProviderNameFromGroup';
import { addressActionToAnalytics } from './shared/addressActionToAnalytics';

function queryWalletProvider(account: Account, address: string) {
  const apiLayer = account.getCurrentWallet();
  const group = apiLayer.getWalletGroupByAddressSync({
    params: { address },
    context: INTERNAL_SYMBOL_CONTEXT,
  });
  return getProviderNameFromGroup(group);
}

function trackAppEvents({ account }: { account: Account }) {
  const getProvider = (address: string) =>
    getProviderForMetabase(queryWalletProvider(account, address));

  const createParams: typeof createBaseParams = (params) => {
    const getUserId = () => account.getUser()?.id;
    return createBaseParams({ ...params, userId: getUserId() });
  };
  emitter.on('dappConnection', ({ origin, address }) => {
    // We don't need user_id here
    const params = createBaseParams({
      request_name: 'dapp_connection',
      dapp_domain: origin,
      wallet_address: address,
      wallet_provider: getProvider(address),
    });
    sendToMetabase('dapp_connection', params);
  });

  emitter.on('screenView', (data) => {
    // We don't need user_id here
    const params = createBaseParams({
      request_name: 'screen_view',
      wallet_address: data.address,
      wallet_provider: data.address ? getProvider(data.address) : null,
      screen_name: data.pathname,
      previous_screen_name: data.previous,
      screen_size: data.screenSize,
    });
    sendToMetabase('screen_view', params);
  });

  emitter.on('daylightAction', ({ event_name, ...data }) => {
    // We don't need user_id here (analytics requirement)
    const params = createBaseParams({
      request_name: 'daylight_action',
      wallet_address: data.address,
      event_name,
      ...data,
    });
    sendToMetabase('daylight_action', params);
  });

  emitter.on(
    'transactionSent',
    async ({
      transaction,
      initiator,
      feeValueCommon,
      addressAction,
      quote,
    }) => {
      const initiatorURL = new URL(initiator);
      const { origin, pathname } = initiatorURL;
      const networks = await networksStore.load();
      const chainId = ethers.utils.hexValue(transaction.chainId);
      const chain = networks.getChainById(chainId)?.toString() || chainId;
      const params = createBaseParams({
        request_name: 'signed_transaction',
        screen_name: origin === initiator ? 'Transaction Request' : pathname,
        wallet_address: transaction.from,
        wallet_provider: getProvider(transaction.from),
        context:
          globalThis.location.origin === origin ? 'Extension' : 'External Dapp',
        type: 'sign',
        dapp_domain: globalThis.location.origin === origin ? null : origin,
        chain,
        gas: transaction.gasLimit.toString(),
        hash: transaction.hash,
        asset_amount_sent: [], // TODO
        gas_price: null, // TODO
        network_fee: null, // TODO
        network_fee_value: feeValueCommon,
        ...addressActionToAnalytics({ addressAction, quote }),
      });
      sendToMetabase('signed_transaction', params);
    }
  );

  function handleSign({
    type,
    initiator,
    address,
  }: {
    type: 'typedDataSigned' | 'messageSigned';
    initiator: string;
    address: string;
  }) {
    if (initiator === INTERNAL_ORIGIN) {
      // Do not send analytics event for internal actions,
      // e.g. a signature made before an invitation fetch request
      return;
    }
    const initiatorURL = new URL(initiator);
    const { origin } = initiatorURL;
    const eventToMethod = {
      // values are ethers method names
      typedDataSigned: '_signTypedData',
      messageSigned: 'signMessage',
    } as const;
    const params = createBaseParams({
      request_name: 'signed_message',
      type: eventToMethod[type] ?? 'unexpected type',
      wallet_address: address,
      address,
      wallet_provider: getProvider(address),
      context:
        globalThis.location.origin === origin ? 'Extension' : 'External Dapp',
      dapp_domain: globalThis.location.origin === origin ? null : origin,
    });
    sendToMetabase('signed_message', params);
  }

  emitter.on('typedDataSigned', ({ typedData, ...rest }) => {
    handleSign({ type: 'typedDataSigned', ...rest });
  });
  emitter.on('messageSigned', ({ message, ...rest }) => {
    handleSign({ type: 'messageSigned', ...rest });
  });

  emitter.on('addEthereumChain', ({ values: [network], origin }) => {
    const params = createParams({
      request_name: 'add_custom_evm',
      source: origin,
      network_external_id: network.external_id,
      network_rpc_url_internal: network.rpc_url_internal,
      network_name: network.name,
      network_native_asset_symbol: network.native_asset?.symbol || null,
      network_explorer_home_url: network.explorer_home_url,
    });
    sendToMetabase('add_custom_evm', params);
  });

  emitter.on('globalPreferencesChange', (state, prevState) => {
    onIdle(() => {
      const { enabled: newlyEnabled, disabled: newlyDisabled } =
        getWalletNameFlagsChange(state, prevState);

      newlyEnabled.forEach((key) => {
        const params = createParams({
          request_name: 'metamask_mode',
          enabled: true,
          dapp_domain: key,
        });
        sendToMetabase('metamask_mode', params);
      });
      newlyDisabled.forEach((key) => {
        const params = createParams({
          request_name: 'metamask_mode',
          enabled: false,
          dapp_domain: key,
        });
        sendToMetabase('metamask_mode', params);
      });
    });
  });
}

export function initialize({ account }: { account: Account }) {
  async function getWalletProvider(address: string) {
    return getProviderForApiV4(queryWalletProvider(account, address));
  }
  initializeApiV4Analytics({
    willSendRequest: createAddProviderHook({ getWalletProvider }),
  });
  return trackAppEvents({ account });
}
