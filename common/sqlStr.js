/**
 * 生成sql语句
 * @param value 要操作的对象
 * @param other 要覆盖的名称，键为字段名，值为要覆盖的sql参数名,值为空则删除操作对象中的属性名
 */
function getNames(value, other) {
    let names = Object.keys(value);
    let argNames = names.map(n => ':' + n);
    if (other)
        for (let n in other) {
            let i = names.indexOf(n)
            if (other[n]) {
                if (i != -1) {
                    argNames[i] = other[n]
                } else {
                    names.push(n)
                    argNames.push(other[n])
                }
            } else {
                if (i != -1) {
                    names.splice(i, 1)
                    argNames.splice(i, 1)
                }
            }
        }
    return { names, argNames }
}
export default {
    insert(table, value, other) {
        let { names, argNames } = getNames(value, other)
        return `insert into ${table}(${names.join(',')}) values(${argNames.join(',')}) `
    },
    insert2(table, value, other, option = null) {
        if (!option) option = { replacements: value }
        else Object.assign(option, { replacements: value })
        return [this.insert(table, value, other), option]
    },
    update(table, value, other, where = "") {
        let { names, argNames } = getNames(value, other)
        for (let i = 0; i < names.length; i++) {
            names[i] = names[i] + "=" + argNames[i]
        }
        return `update ${table} set ${names.join(',')} ${where}`
    },
    update2(table, value, other, where = "", option = null) {
        let replacements = value
        if (typeof where == 'object') {
            replacements = Object.assign(where, value)
            if (!other) other = {}
            for (let n in where) {
                other[n] = null
            }
            where = "where " + Object.keys(where).map(n => `${n}=:${n}`).join(" and ")
        }
        if (!option) option = { replacements }
        else Object.assign(option, { replacements })
        return [this.update(table, value, other, where), option]
    }
}