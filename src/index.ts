/** 包入口:默认导出 `WorldDefinition`,加载器按 `cortico.kind === 'world'` 认它。 */
import { QQ2 } from './definition.ts';

export default QQ2;
export { QQ2 };
export { QQ2World, EVENT_SOURCE, enabledRosterIds } from './world.ts';
export type { QQConfigSection, QQRosterEntry } from './config.ts';
export {
  DEFAULT_MODE,
  MODE_LABEL,
  MODE_RECEIPT,
  QQ_MODES,
  convOf,
  isQQMode,
  planDelivery,
  type Conv,
  type DeliveryPlan,
  type QQMode,
} from './modes.ts';
