# 共绩算力 Open API 接口索引

本索引由 `source-llms.txt` 和本地 OpenAPI 页面生成。详情页保留供应商原始字段与 Schema。当前共 67 个接口。

## 资源

| 接口 | 方法 | 供应商路径 | API ID |
| --- | --- | --- | --- |
| [获取设备资源列表](./api/api-296881020.md) | `GET` | `/api/deployment/resource/search` | `296881020` |
| [获取对象存储加速资源列表](./api/api-314646799.md) | `GET` | `/api/storage/get_storage` | `314646799` |
| [获取共享存储卷资源列表](./api/api-407029996.md) | `GET` | `/api/storage/get_storage` | `407029996` |

## 弹性部署服务任务

| 接口 | 方法 | 供应商路径 | API ID |
| --- | --- | --- | --- |
| [任务列表查询接口](./api/api-296881864.md) | `GET` | `/api/deployment/task/search` | `296881864` |
| [任务详情查询接口](./api/api-402249411.md) | `GET` | `/api/deployment/task/detail` | `402249411` |
| [任务创建接口](./api/api-296881505.md) | `POST` | `/api/deployment/task/create` | `296881505` |
| [任务修改接口](./api/api-269530619.md) | `POST` | `/api/deployment/task/update` | `269530619` |
| [任务恢复接口](./api/api-296882718.md) | `POST` | `/api/deployment/task/recover` | `296882718` |
| [任务暂停接口](./api/api-296882601.md) | `POST` | `/api/deployment/task/pause` | `296882601` |
| [任务删除接口](./api/api-314631776.md) | `POST` | `/api/deployment/task/stop` | `314631776` |
| [节点数量修改接口](./api/api-296883326.md) | `POST` | `/api/deployment/task/change_points` | `296883326` |
| [新版任务列表查询接口](./api/api-434983162.md) | `GET` | `/api/task/deployment/search` | `434983162` |
| [新版任务详情查询接口](./api/api-433641836.md) | `GET` | `/api/task/deployment/detail` | `433641836` |
| [新版任务创建接口](./api/api-434943737.md) | `POST` | `/api/task/deployment/create` | `434943737` |
| [新版任务修改接口](./api/api-434978613.md) | `POST` | `/api/task/deployment/update` | `434978613` |

## 镜像预热任务(申请开通)

| 接口 | 方法 | 供应商路径 | API ID |
| --- | --- | --- | --- |
| [镜像预热任务可用集群列表](./api/api-483003688.md) | `GET` | `/api/task/image_preheat/get_regions` | `483003688` |
| [镜像预热任务列表查询接口](./api/api-469645041.md) | `GET` | `/api/task/image_preheat/search` | `469645041` |
| [镜像预热任务详情查询接口](./api/api-469645043.md) | `GET` | `/api/task/image_preheat/detail` | `469645043` |
| [镜像预热任务创建接口](./api/api-469645046.md) | `POST` | `/api/task/image_preheat/create` | `469645046` |
| [镜像预热任务更新接口](./api/api-469645047.md) | `POST` | `/api/task/image_preheat/update` | `469645047` |
| [镜像预热任务停止接口](./api/api-469651964.md) | `POST` | `/api/task/image_preheat/stop` | `469651964` |

## Job批处理任务

| 接口 | 方法 | 供应商路径 | API ID |
| --- | --- | --- | --- |
| [Job任务列表查询接口](./api/api-471289575.md) | `GET` | `/api/task/job/search` | `471289575` |
| [Job任务详情查询接口](./api/api-471290244.md) | `GET` | `/api/task/job/detail` | `471290244` |
| [Job任务创建接口](./api/api-445572292.md) | `POST` | `/api/task/job/create` | `445572292` |
| [Job任务停止接口](./api/api-446681900.md) | `POST` | `/api/task/job/stop` | `446681900` |

## Job批处理任务队列

| 接口 | 方法 | 供应商路径 | API ID |
| --- | --- | --- | --- |
| [Job任务队列列表查询接口](./api/api-469630946.md) | `GET` | `/api/job/queue/search` | `469630946` |
| [Job任务队列详情查询接口](./api/api-469630948.md) | `GET` | `/api/job/queue/detail` | `469630948` |
| [Job任务队列创建接口](./api/api-469630957.md) | `POST` | `/api/job/queue/create` | `469630957` |
| [Job任务队列更新接口](./api/api-469643529.md) | `POST` | `/api/job/queue/update` | `469643529` |
| [Job任务队列停止接口](./api/api-469630958.md) | `POST` | `/api/job/queue/stop` | `469630958` |
| [Job任务队列任务组推送接口](./api/api-469643556.md) | `POST` | `/api/job/queue/encrypt/push` | `469643556` |
| [Job任务队列任务组列表查询接口](./api/api-469643677.md) | `GET` | `/api/job/queue/group/search` | `469643677` |
| [Job任务队列任务组详情查询接口](./api/api-469644479.md) | `GET` | `/api/job/queue/group/detail` | `469644479` |
| [Job任务队列任务组批量停止接口](./api/api-469644675.md) | `POST` | `/api/job/queue/group/stops` | `469644675` |

## 弹性部署服务/Job批处理节点

| 接口 | 方法 | 供应商路径 | API ID |
| --- | --- | --- | --- |
| [节点列表查询接口](./api/api-296885186.md) | `GET` | `/api/deployment/task/points` | `296885186` |
| [节点日志查询接口](./api/api-335612564.md) | `GET` | `/api/deployment/task/point_log` | `335612564` |
| [节点事件查询接口](./api/api-335613302.md) | `GET` | `/api/deployment/task/pod_event` | `335613302` |
| [任务节点删除接口](./api/api-301355246.md) | `POST` | `/api/deployment/task/delete_pod` | `301355246` |

## 费用

| 接口 | 方法 | 供应商路径 | API ID |
| --- | --- | --- | --- |
| [弹性部署/云主机-时间维度计费查询接口](./api/api-310631391.md) | `GET` | `/api/billing/get_billing_record` | `310631391` |
| [弹性部署/云主机-任务维度计费查询接口](./api/api-406942396.md) | `GET` | `/api/billing/get_task_billing_record` | `406942396` |
| [镜像仓库-计费查询接口](./api/api-406942464.md) | `GET` | `/api/harbor/support/billing/get_billing_record` | `406942464` |
| [对象存储加速-计费查询接口](./api/api-406942592.md) | `GET` | `/api/storage/billing/get_billing_record` | `406942592` |
| [共享存储卷-计费查询接口](./api/api-406942682.md) | `GET` | `/api/storage/billing/get_billing_record` | `406942682` |

## 存储 > 对象存储

| 接口 | 方法 | 供应商路径 | API ID |
| --- | --- | --- | --- |
| [查询对象存储可选元数据区域](./api/api-478747303.md) | `GET` | `/api/storage/get_k3s_regions` | `478747303` |
| [查询对象存储加速可选区域](./api/api-478747304.md) | `GET` | `/api/storage/get_regions` | `478747304` |
| [查询对象存储列表](./api/api-478747305.md) | `GET` | `/api/storage/get_storage` | `478747305` |
| [按 ID 查询对象存储](./api/api-478747306.md) | `GET` | `/api/storage/get_storage_by_ids` | `478747306` |
| [查询对象存储容量用量概览](./api/api-478747307.md) | `GET` | `/api/storage/storage_info` | `478747307` |
| [校验对象存储连接](./api/api-478747308.md) | `POST` | `/api/storage/encrypt/check` | `478747308` |
| [创建对象存储配置](./api/api-478747309.md) | `POST` | `/api/storage/encrypt/create` | `478747309` |
| [更新对象存储配置](./api/api-478747310.md) | `POST` | `/api/storage/encrypt/update` | `478747310` |
| [浏览对象存储桶目录](./api/api-478747311.md) | `POST` | `/api/storage/s3/bucket/list` | `478747311` |
| [预热导入对象存储数据](./api/api-478747312.md) | `POST` | `/api/storage/s3/bucket/preheat` | `478747312` |
| [浏览对象存储已导入元数据](./api/api-478747313.md) | `POST` | `/api/storage/s3/metadata/list` | `478747313` |
| [删除对象存储已导入元数据](./api/api-478747314.md) | `POST` | `/api/storage/s3/metadata/delete` | `478747314` |
| [激活对象存储](./api/api-478747316.md) | `POST` | `/api/storage/activate_v2` | `478747316` |
| [释放对象存储](./api/api-478747317.md) | `POST` | `/api/storage/release` | `478747317` |
| [删除对象存储配置](./api/api-478747318.md) | `POST` | `/api/storage/delete` | `478747318` |

## 裸金属 > 已购列表

| 接口 | 方法 | 供应商路径 | API ID |
| --- | --- | --- | --- |
| [已购单机设备列表](./api/api-496769693.md) | `POST` | `/api/output/v2/device-output/list_rent_device_single_v2` | `496769693` |
| [已购组网设备列表](./api/api-496695377.md) | `POST` | `/api/output/v2/device-output/list_rent_device_network_v2` | `496695377` |
| [设备详情【开机信息】](./api/api-497148897.md) | `POST` | `/api/output/v2/device_order/get_device_details_v2` | `497148897` |

## 裸金属 > 创建订单

| 接口 | 方法 | 供应商路径 | API ID |
| --- | --- | --- | --- |
| [创建订单](./api/api-496722319.md) | `POST` | `/api/output/v2/device_order/buy_v2` | `496722319` |
| [已购设备自动续费](./api/api-496853781.md) | `POST` | `/api/output/v2/auto_renew_device_config/set_auto_renew_config` | `496853781` |
| [已购设备取消自动续费](./api/api-496854525.md) | `POST` | `/api/output/v2/auto_renew_device_config/delete_auto_renew_config` | `496854525` |

## 裸金属 > 可购列表

| 接口 | 方法 | 供应商路径 | API ID |
| --- | --- | --- | --- |
| [单机设备可购列表](./api/api-496591301.md) | `POST` | `/api/output/v2/device-output/page_list_product_single_v2` | `496591301` |
| [组网设备可购列表](./api/api-496652989.md) | `POST` | `/api/output/v2/device-output/page_list_product_network_v2` | `496652989` |

## 裸金属 > 订单列表

| 接口 | 方法 | 供应商路径 | API ID |
| --- | --- | --- | --- |
| [订单列表](./api/api-496881804.md) | `POST` | `/api/output/v2/device_order/get_order_list_v2` | `496881804` |

