/**
 * data.js —— 全部的「虚构餐品数据」和「筛选选项配置」
 *
 * 这个文件是唯一的数据来源，页面上的筛选项和餐品都由它生成。
 * 想加一道菜？照抄一行改内容就行（id 不能重复）。
 * 想改预算档位？改 BUDGET_OPTIONS 里的数字就行。
 *
 * 注意：所有餐品、价格、地点都是编的，只用于这次练习，不涉及任何真实店铺。
 */

/** 辣度等级：0 = 不辣，1 = 微辣，2 = 中辣，3 = 特辣 */
export const SPICY_LABELS = ['不辣', '微辣', '中辣', '特辣'];

/** 预算档位：value 是「最多多少钱」，0 表示不限 */
export const BUDGET_OPTIONS = [
  { value: 0, label: '不限' },
  { value: 8, label: '8 元内' },
  { value: 12, label: '12 元内' },
  { value: 16, label: '16 元内' },
  { value: 20, label: '20 元内' },
];

/** 辣度上限档位：value 是「最多能吃到几级辣」，3 表示不限 */
export const SPICY_OPTIONS = [
  { value: 3, label: '都能吃' },
  { value: 2, label: '最多中辣' },
  { value: 1, label: '最多微辣' },
  { value: 0, label: '完全不吃辣' },
];

/** 20 种虚构校园餐品（id / 名称 / 价格 / 地点 / 辣度 / 类型 / 一句介绍） */
export const DISHES = [
  { id: 'd01', name: '番茄鸡蛋盖饭', price: 12, place: '一食堂', spicyLevel: 0, type: '米饭', note: '食堂经典款，出餐快，几乎不踩雷' },
  { id: 'd02', name: '香菇青菜面', price: 9, place: '一食堂', spicyLevel: 0, type: '面食', note: '清淡暖胃，赶时间也能吃完' },
  { id: 'd03', name: '清炒时蔬套餐', price: 13, place: '一食堂', spicyLevel: 0, type: '米饭', note: '两素一荤，油腻感最低的一顿' },
  { id: 'd04', name: '皮蛋瘦肉粥', price: 6, place: '一食堂', spicyLevel: 0, type: '粥品', note: '胃不太舒服的时候点它准没错' },
  { id: 'd05', name: '素三鲜馄饨', price: 11, place: '一食堂', spicyLevel: 0, type: '面食', note: '皮薄馅大，一碗刚好不撑' },

  { id: 'd06', name: '红烧牛肉面', price: 16, place: '二食堂', spicyLevel: 1, type: '面食', note: '汤头浓郁，牛肉块大，冷天首选' },
  { id: 'd07', name: '黄焖鸡米饭', price: 18, place: '二食堂', spicyLevel: 2, type: '米饭', note: '分量扎实，汤汁拌饭特别香' },
  { id: 'd08', name: '藤椒鸡丝凉面', price: 14, place: '二食堂', spicyLevel: 2, type: '面食', note: '麻香不腻，天热的时候很下饭' },
  { id: 'd09', name: '玉米排骨汤套餐', price: 17, place: '二食堂', spicyLevel: 0, type: '汤锅', note: '有汤有饭，想吃清淡的晚上选它' },

  { id: 'd10', name: '麻辣香锅（小份）', price: 22, place: '三食堂', spicyLevel: 3, type: '米饭', note: '配菜自己挑，辣度可以现场调整' },
  { id: 'd11', name: '麻辣烫（自选称重）', price: 15, place: '三食堂', spicyLevel: 3, type: '汤锅', note: '想吃多少夹多少，丰俭由人' },
  { id: 'd12', name: '咖喱鸡肉饭', price: 20, place: '三食堂', spicyLevel: 1, type: '米饭', note: '咖喱偏甜口，不吃辣的同学也能吃' },

  { id: 'd13', name: '手抓饼加蛋', price: 7, place: '小吃街', spicyLevel: 1, type: '小吃', note: '边走边吃，早餐救急第一名' },
  { id: 'd14', name: '酸辣粉', price: 9, place: '小吃街', spicyLevel: 2, type: '小吃', note: '酸辣开胃，汤别喝太干净' },
  { id: 'd15', name: '鸡蛋灌饼', price: 6, place: '小吃街', spicyLevel: 1, type: '小吃', note: '几分钟出锅，上课前正好赶上' },
  { id: 'd16', name: '香辣鸡腿堡', price: 13, place: '小吃街', spicyLevel: 2, type: '小吃', note: '赶时间又想吃饱的选择' },

  { id: 'd17', name: '铁板鱿鱼饭', price: 19, place: '东门夜市', spicyLevel: 3, type: '米饭', note: '锅气足，晚自习后吃一份很满足' },
  { id: 'd18', name: '芝士年糕锅', price: 24, place: '东门夜市', spicyLevel: 2, type: '汤锅', note: '分量大，两个人拼一份更划算' },

  { id: 'd19', name: '酸奶水果杯', price: 8, place: '咖啡角', spicyLevel: 0, type: '轻食', note: '想控制热量时的替代方案' },
  { id: 'd20', name: '冰美式 + 三明治', price: 15, place: '咖啡角', spicyLevel: 0, type: '轻食', note: '赶作业套餐，主要是为了提神' },
];
