(function (root, factory) {
    const scheduler = factory();

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = scheduler;
    } else {
        root.StudyScheduler = scheduler;
    }
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
    const DAY_MS = 24 * 60 * 60 * 1000;

    function toDateKey(value, label) {
        let key;

        if (value instanceof Date) {
            const year = value.getFullYear();
            const month = String(value.getMonth() + 1).padStart(2, '0');
            const day = String(value.getDate()).padStart(2, '0');
            key = `${year}-${month}-${day}`;
        } else {
            key = String(value).slice(0, 10);
        }

        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
        if (!match) {
            throw new Error(`${label} 날짜는 YYYY-MM-DD 형식이어야 합니다.`);
        }

        const year = Number(match[1]);
        const month = Number(match[2]);
        const day = Number(match[3]);
        const check = new Date(Date.UTC(year, month - 1, day));

        if (
            check.getUTCFullYear() !== year ||
            check.getUTCMonth() !== month - 1 ||
            check.getUTCDate() !== day
        ) {
            throw new Error(`${label} 날짜가 올바르지 않습니다.`);
        }

        return key;
    }

    function dateKeyToUtc(key) {
        const [year, month, day] = key.split('-').map(Number);
        return Date.UTC(year, month - 1, day);
    }

    function getDaysUntilExam(examDate, today) {
        const examKey = toDateKey(examDate, '시험');
        const todayKey = toDateKey(today, '오늘');
        const difference = Math.floor(
            (dateKeyToUtc(examKey) - dateKeyToUtc(todayKey)) / DAY_MS
        );

        // 시험이 지난 과목 때문에 다른 과목의 계산까지 중단되지 않게 합니다.
        return Math.max(1, difference);
    }
    function calculatePriority(subject, today) {
        const importance = Number(subject.importance);
        const baseNeed = Number(subject.studyNeed);
        const temporaryBonus = Number(subject.temporaryNeedBonus || 0);
        const permanentBonus = Number(subject.permanentNeedBonus || 0);

        if (!Number.isFinite(importance) || importance < 1 || importance > 5) {
            throw new Error(`${subject.name} 과목의 중요도는 1~5여야 합니다.`);
        }
        if (!Number.isFinite(baseNeed)) {
            throw new Error(`${subject.name} 과목의 필요도가 올바르지 않습니다.`);
        }

        const currentNeed = Math.max(
            0,
            baseNeed + temporaryBonus + permanentBonus
        );
        const daysUntilExam = getDaysUntilExam(subject.examDate, today);
        const priority = importance * currentNeed / Math.sqrt(daysUntilExam); //  우선순위 알고리즘 중요도 * 필요도 * 시험 임박도

        return {
            ...subject,
            currentNeed,
            daysUntilExam,
            priority
        };
    }
    function distributeSlots(subjects, totalSlots, today) {
        if (!Array.isArray(subjects) || subjects.length === 0) {
            throw new Error('과목을 하나 이상 입력해 주세요.');
        }
        if (!Number.isInteger(totalSlots) || totalSlots < 0) {
            throw new Error('가능한 시간 칸 수가 올바르지 않습니다.');
        }
        const scored = subjects.map((subject) =>
            calculatePriority(subject, today)
        );
        const baseSlots = totalSlots >= scored.length ? 1 : 0;
        const extraSlots = totalSlots - baseSlots * scored.length;           // 기본 베이스 제외한 시간
        const priorityTotal = scored.reduce(
            (sum, subject) => sum + subject.priority,
            0
        );
        const weights = scored.map((subject) =>
            priorityTotal === 0 ? 1 : subject.priority
        );
        const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);

        const allocations = scored.map((subject, index) => {
            const exactExtra = extraSlots * weights[index] / weightTotal;     // 기본베이스 * 현재 과목의 우선순위 / 과목 전체 우선순위 합    ex) = 7 × 0.4 = 2.8시간   
            const wholeExtra = Math.floor(exactExtra);                        // 소수점 처리 

            return {
                ...subject,
                allocatedSlots: baseSlots + wholeExtra,
                fractionalPart: exactExtra - wholeExtra,
                originalIndex: index
            };
        });

        let leftover = totalSlots - allocations.reduce(
            (sum, subject) => sum + subject.allocatedSlots,
            0
        );

        const remainderOrder = [...allocations].sort((a, b) => {
            if (b.fractionalPart !== a.fractionalPart) {
                return b.fractionalPart - a.fractionalPart;
            }
            if (b.priority !== a.priority) {
                return b.priority - a.priority;
            }
            return a.originalIndex - b.originalIndex;
        });

        for (let index = 0; index < leftover; index++) {
            remainderOrder[index].allocatedSlots += 1;
        }

        return allocations.map(({ fractionalPart, originalIndex, ...subject }) => subject);
    }

    function distributeFutureSlots(
        subjects,
        futureSlotCount,
        priorityDate,
        fixedSchedule = [],
        totalWeekSlotCount = futureSlotCount + fixedSchedule.length
    ) {
        if (!Number.isInteger(futureSlotCount) || futureSlotCount < 0 || !Array.isArray(fixedSchedule)) {
            throw new Error('남은 시간표 정보가 올바르지 않습니다.');
        }
        if (!Number.isInteger(totalWeekSlotCount) || totalWeekSlotCount < futureSlotCount) {
            throw new Error('이번 주 전체 시간표 정보가 올바르지 않습니다.');
        }

        const fixedCounts = new Map(subjects.map((subject) => [subject.id, 0]));
        for (const item of fixedSchedule) {
            if (fixedCounts.has(item.subjectId)) {
                fixedCounts.set(item.subjectId, fixedCounts.get(item.subjectId) + 1);
            }
        }

        const weeklyTargets = distributeSlots(
            subjects,
            totalWeekSlotCount,
            priorityDate
        );
        const futureAllocations = weeklyTargets.map((subject) => ({
            ...subject,
            weeklyTargetSlots: subject.allocatedSlots,
            fixedSlots: fixedCounts.get(subject.id),
            allocatedSlots: Math.max(0, subject.allocatedSlots - fixedCounts.get(subject.id))
        }));

        let excess = futureAllocations.reduce((sum, subject) => sum + subject.allocatedSlots, 0) - futureSlotCount;
        const reductionOrder = [...futureAllocations].sort((a, b) =>
            a.priority - b.priority || b.allocatedSlots - a.allocatedSlots || a.id - b.id
        );
        for (const subject of reductionOrder) {
            if (excess <= 0) break;
            const reduction = Math.min(excess, subject.allocatedSlots);
            subject.allocatedSlots -= reduction;
            excess -= reduction;
        }

        return futureAllocations;
    }

    function findTemporaryNeedBonus(
        subjects,
        futureSlotCount,
        priorityDate,
        subjectId,
        additionalSlots,
        fixedSchedule = [],
        totalWeekSlotCount = futureSlotCount + fixedSchedule.length
    ) {
        if (!Number.isInteger(additionalSlots) || additionalSlots < 1) {
            throw new Error('보충할 시간은 1시간 이상이어야 합니다.');
        }

        const original = subjects.find((subject) => subject.id === subjectId);
        if (!original) {
            throw new Error('선택한 과목을 찾을 수 없습니다.');
        }

        const baseline = distributeFutureSlots(
            subjects, futureSlotCount, priorityDate, fixedSchedule, totalWeekSlotCount
        );
        const baselineAllocation = baseline.find((subject) => subject.id === subjectId);
        const targetSlots = baselineAllocation.allocatedSlots + additionalSlots;
        const maximumSlots = futureSlotCount;

        if (targetSlots > maximumSlots) {
            throw new Error(`${original.name} 과목에 ${additionalSlots}시간을 더 배정할 수 있는 공부 시간이 부족합니다.`);
        }

        const startingBonus = Number(original.temporaryNeedBonus || 0);
        for (let bonus = startingBonus; bonus <= startingBonus + 100000; bonus++) {
            const candidates = subjects.map((subject) => subject.id === subjectId
                ? { ...subject, temporaryNeedBonus: bonus }
                : subject
            );
            const allocations = distributeFutureSlots(
                candidates, futureSlotCount, priorityDate, fixedSchedule, totalWeekSlotCount
            );
            const target = allocations.find((subject) => subject.id === subjectId);

            if (target.allocatedSlots >= targetSlots) {
                return {
                    subjects: candidates,
                    allocations,
                    temporaryNeedBonus: bonus,
                    addedTemporaryNeed: bonus - startingBonus,
                    baselineAllocation: baselineAllocation.allocatedSlots,
                    targetAllocation: target.allocatedSlots
                };
            }
        }

        throw new Error(`${original.name} 과목의 추가 시간을 계산하지 못했습니다.`);
    }

    function completeMakeup(subjects, totalSlots, priorityDate, actualSchedule) {
        const hasPendingMakeup = subjects.some(
            (subject) => Number(subject.temporaryNeedBonus || 0) > 0
        );
        if (!hasPendingMakeup) {
            return { subjects, lostHours: [], hasPendingMakeup: false };
        }

        const trackedSlots = Array.isArray(actualSchedule) ? actualSchedule.length : totalSlots;
        const currentCounts = new Map(subjects.map((subject) => [subject.id, 0]));
        if (Array.isArray(actualSchedule)) {
            for (const item of actualSchedule) {
                if (currentCounts.has(item.subjectId)) {
                    currentCounts.set(item.subjectId, currentCounts.get(item.subjectId) + 1);
                }
            }
        } else {
            for (const subject of distributeSlots(subjects, trackedSlots, priorityDate)) {
                currentCounts.set(subject.id, subject.allocatedSlots);
            }
        }
        const withoutTemporaryBonus = subjects.map((subject) => ({
            ...subject,
            temporaryNeedBonus: 0
        }));
        const baselineAllocations = distributeSlots(withoutTemporaryBonus, trackedSlots, priorityDate);
        const lostHours = [];

        const completedSubjects = withoutTemporaryBonus.map((subject) => {
            const baseline = baselineAllocations.find((item) => item.id === subject.id);
            const lost = Math.max(0, baseline.allocatedSlots - currentCounts.get(subject.id));

            if (lost > 0) {
                lostHours.push({ subjectId: subject.id, subjectName: subject.name, hours: lost });
            }

            return {
                ...subject,
                permanentNeedBonus: Number(subject.permanentNeedBonus || 0) + lost * 7
            };
        });

        return { subjects: completedSubjects, lostHours, hasPendingMakeup: true };
    }

    function makeLegacySchedule(subjects, availableSlots, priorityDate) {
        const slots = availableSlots.map((slot) => ({
            studyDate: toDateKey(slot.studyDate, '공부'),
            startHour: Number(slot.startHour)
        })).sort((a, b) =>
            a.studyDate.localeCompare(b.studyDate) || a.startHour - b.startHour
        );
        if (slots.length < subjects.length) {
            throw new Error('기존 시간표를 복원할 수 있는 공부 가능 시간이 부족합니다.');
        }

        const allocations = distributeSlots(subjects, slots.length, priorityDate);
        const assignedCount = new Map(allocations.map((subject) => [subject.id, 0]));
        const remainingCount = new Map(allocations.map((subject) => [subject.id, subject.allocatedSlots]));
        const schedule = [];

        for (const slot of slots) {
            const candidates = allocations
                .filter((subject) =>
                    remainingCount.get(subject.id) > 0 && subject.examDate > slot.studyDate
                )
                .sort((a, b) => {
                    const aProgress = assignedCount.get(a.id) / a.allocatedSlots;
                    const bProgress = assignedCount.get(b.id) / b.allocatedSlots;
                    return aProgress - bProgress || b.priority - a.priority;
                });
            const chosen = candidates[0];
            if (!chosen) {
                // 시험일 당일 이후의 슬롯은 어떤 과목에도 배정하지 않습니다.
                continue;
            }

            schedule.push({
                studyDate: slot.studyDate,
                startHour: slot.startHour,
                subjectId: chosen.id,
                subjectName: chosen.name,
                candidates: candidates.map((subject) => ({
                    subjectId: subject.id,
                    subjectName: subject.name,
                    assignedBefore: assignedCount.get(subject.id),
                    allocatedSlots: subject.allocatedSlots,
                    progress: assignedCount.get(subject.id) / subject.allocatedSlots,
                    priority: subject.priority
                }))
            });
            assignedCount.set(chosen.id, assignedCount.get(chosen.id) + 1);
            remainingCount.set(chosen.id, remainingCount.get(chosen.id) - 1);
        }

        return { allocations, schedule };
    }

    function makeSchedule(
        subjects,
        availableSlots,
        today,
        fixedSchedule = [],
        priorityDate = today,
        totalWeekSlotCount
    ) {
        if (!Array.isArray(availableSlots)) {
            throw new Error('가능한 시간 칸 목록이 올바르지 않습니다.');
        }
        if (!Array.isArray(fixedSchedule)) {
            throw new Error('이미 지난 시간표가 올바르지 않습니다.');
        }

        // 시험일 당일과 그 이후에는 해당 과목을 새 시간표에서 제외합니다.
        subjects = subjects.filter((subject) => toDateKey(subject.examDate, '시험') > toDateKey(today, '오늘'));
        if (subjects.length === 0) {
            return { allocations: [], schedule: [] };
        }

        const slots = availableSlots.map((slot) => {
            const studyDate = toDateKey(slot.studyDate, '공부');
            const startHour = Number(slot.startHour);

            if (!Number.isInteger(startHour) || startHour < 9 || startHour > 21) {
                throw new Error('시작 시간은 9시부터 21시 사이여야 합니다.');
            }

            return { studyDate, startHour };
        }).sort((a, b) =>
            a.studyDate.localeCompare(b.studyDate) || a.startHour - b.startHour
        );

        const slotKeys = slots.map(
            (slot) => `${slot.studyDate}_${slot.startHour}`
        );
        if (new Set(slotKeys).size !== slotKeys.length) {
            throw new Error('같은 날짜와 시간 칸이 중복되어 있습니다.');
        }

        const weeklySlotCount = totalWeekSlotCount ?? slots.length + fixedSchedule.length;
        const remainingAllocations = distributeFutureSlots(
            subjects, slots.length, priorityDate, fixedSchedule, weeklySlotCount
        );
        const allocations = distributeSlots(subjects, weeklySlotCount, priorityDate);
        const assignedCount = new Map(allocations.map((subject) => [
            subject.id,
            fixedSchedule.filter((item) => item.subjectId === subject.id).length
        ]));
        const remainingCount = new Map(remainingAllocations.map((subject) => [
            subject.id,
            subject.allocatedSlots
        ]));
        const schedule = [];

        function getCandidates(slotIndex) {
            const slot = slots[slotIndex];
            return remainingAllocations
                .filter((subject) =>
                    remainingCount.get(subject.id) > 0 && subject.examDate > slot.studyDate
                )
                .map((subject) => {
                    const eligibleSlots = slots.slice(slotIndex)
                        .filter((candidateSlot) => candidateSlot.studyDate <= subject.examDate).length;
                    return {
                        ...subject,
                        urgency: eligibleSlots > 0 ? remainingCount.get(subject.id) / eligibleSlots : Infinity
                    };
                })
                .sort((a, b) =>
                    b.urgency - a.urgency ||
                    a.examDate.localeCompare(b.examDate) ||
                    b.priority - a.priority
                );
        }

        let runStart = 0;
        while (runStart < slots.length) {
            let runEnd = runStart + 1;
            while (
                runEnd < slots.length &&
                slots[runEnd].studyDate === slots[runEnd - 1].studyDate &&
                slots[runEnd].startHour === slots[runEnd - 1].startHour + 1
            ) {
                runEnd++;
            }

            let slotIndex = runStart;
            while (slotIndex < runEnd) {
                const candidates = getCandidates(slotIndex);
                const chosen = candidates[0];
                if (!chosen) {
                    // 남은 과목의 시험일이 지난 칸은 비워 두고 시간표 생성을 계속합니다.
                    slotIndex++;
                    continue;
                }

                const blockLength = Math.min(remainingCount.get(chosen.id), runEnd - slotIndex);
                for (let offset = 0; offset < blockLength; offset++) {
                    const slot = slots[slotIndex];
                    const candidateSnapshot = getCandidates(slotIndex);
                    schedule.push({
                        studyDate: slot.studyDate,
                        startHour: slot.startHour,
                        subjectId: chosen.id,
                        subjectName: chosen.name,
                        candidates: candidateSnapshot.map((subject) => {
                            const before = assignedCount.get(subject.id);
                            return {
                                subjectId: subject.id,
                                subjectName: subject.name,
                                assignedBefore: before,
                                allocatedSlots: subject.weeklyTargetSlots,
                                progress: subject.weeklyTargetSlots > 0
                                    ? before / subject.weeklyTargetSlots
                                    : 1,
                                urgency: subject.urgency,
                                priority: subject.priority
                            };
                        })
                    });
                    assignedCount.set(chosen.id, assignedCount.get(chosen.id) + 1);
                    remainingCount.set(chosen.id, remainingCount.get(chosen.id) - 1);
                    slotIndex++;
                }
            }
            runStart = runEnd;
        }

        // 같은 날 배정된 과목을 한 시간 구간 안에 모을 수 있으면 블록으로 옮깁니다.
        const subjectById = new Map(allocations.map((subject) => [subject.id, subject]));
        let dayStart = 0;
        while (dayStart < schedule.length) {
            let dayEnd = dayStart + 1;
            while (dayEnd < schedule.length && schedule[dayEnd].studyDate === schedule[dayStart].studyDate) {
                dayEnd++;
            }

            const runs = [];
            let runStart = dayStart;
            for (let index = dayStart + 1; index <= dayEnd; index++) {
                const isEndOfRun = index === dayEnd ||
                    schedule[index].startHour !== schedule[index - 1].startHour + 1;
                if (isEndOfRun) {
                    runs.push(Array.from({ length: index - runStart }, (_, offset) => runStart + offset));
                    runStart = index;
                }
            }

            const dailyCounts = new Map();
            for (let index = dayStart; index < dayEnd; index++) {
                const subjectId = schedule[index].subjectId;
                dailyCounts.set(subjectId, (dailyCounts.get(subjectId) || 0) + 1);
            }
            const blocks = [...dailyCounts.entries()].map(([subjectId, count]) => {
                const subject = subjectById.get(subjectId);
                return {
                    subjectId,
                    subjectName: subject.name,
                    examDate: subject.examDate,
                    priority: subject.priority,
                    count
                };
            }).sort((a, b) =>
                b.count - a.count ||
                a.examDate.localeCompare(b.examDate) ||
                b.priority - a.priority
            );

            const remainingCapacity = runs.map((run) => run.length);
            const blockRun = new Array(blocks.length).fill(-1);
            function fitBlocks(blockIndex) {
                if (blockIndex === blocks.length) {
                    return remainingCapacity.every((capacity) => capacity === 0);
                }

                const triedCapacities = new Set();
                for (let runIndex = 0; runIndex < runs.length; runIndex++) {
                    const capacity = remainingCapacity[runIndex];
                    if (capacity < blocks[blockIndex].count || triedCapacities.has(capacity)) continue;
                    triedCapacities.add(capacity);
                    remainingCapacity[runIndex] -= blocks[blockIndex].count;
                    blockRun[blockIndex] = runIndex;
                    if (fitBlocks(blockIndex + 1)) return true;
                    remainingCapacity[runIndex] += blocks[blockIndex].count;
                    blockRun[blockIndex] = -1;
                }
                return false;
            }

            if (fitBlocks(0)) {
                const blocksByRun = runs.map(() => []);
                blocks.forEach((block, index) => blocksByRun[blockRun[index]].push(block));
                for (let runIndex = 0; runIndex < runs.length; runIndex++) {
                    const runBlocks = blocksByRun[runIndex].sort((a, b) =>
                        a.examDate.localeCompare(b.examDate) ||
                        b.priority - a.priority ||
                        a.subjectId - b.subjectId
                    );
                    let slotOffset = 0;
                    for (const block of runBlocks) {
                        for (let offset = 0; offset < block.count; offset++) {
                            const item = schedule[runs[runIndex][slotOffset++]];
                            item.subjectId = block.subjectId;
                            item.subjectName = block.subjectName;
                        }
                    }
                }
            }

            dayStart = dayEnd;
        }

        // 블록 재배치 뒤에도 개발자 도구에 표시되는 후보가 실제 시간표와 맞도록 다시 만듭니다.
        const diagnosticCounts = new Map(allocations.map((subject) => [
            subject.id,
            fixedSchedule.filter((item) => item.subjectId === subject.id).length
        ]));
        for (let index = 0; index < schedule.length; index++) {
            const item = schedule[index];
            item.candidates = allocations
                .filter((subject) => subject.examDate > item.studyDate)
                .map((subject) => {
                    const assignedBefore = diagnosticCounts.get(subject.id);
                    const eligibleSlots = slots.slice(index)
                        .filter((slot) => slot.studyDate <= subject.examDate).length;
                    const remaining = Math.max(0, subject.allocatedSlots - assignedBefore);
                    return {
                        subjectId: subject.id,
                        subjectName: subject.name,
                        assignedBefore,
                        allocatedSlots: subject.allocatedSlots,
                        progress: subject.allocatedSlots > 0 ? assignedBefore / subject.allocatedSlots : 1,
                        urgency: eligibleSlots > 0 ? remaining / eligibleSlots : Infinity,
                        priority: subject.priority
                    };
                })
                .sort((a, b) =>
                    b.urgency - a.urgency ||
                    a.subjectName.localeCompare(b.subjectName) ||
                    b.priority - a.priority
                );
            diagnosticCounts.set(item.subjectId, diagnosticCounts.get(item.subjectId) + 1);
        }

        const actualWeeklyCounts = new Map(allocations.map((subject) => [
            subject.id,
            fixedSchedule.filter((item) => item.subjectId === subject.id).length
        ]));
        for (const item of schedule) {
            actualWeeklyCounts.set(item.subjectId, actualWeeklyCounts.get(item.subjectId) + 1);
        }
        const reportedAllocations = allocations.map((subject) => ({
            ...subject,
            weeklyTargetSlots: subject.allocatedSlots,
            allocatedSlots: actualWeeklyCounts.get(subject.id)
        }));

        return { allocations: reportedAllocations, schedule };
    }

    return {
        calculatePriority,
        distributeSlots,
        distributeFutureSlots,
        findTemporaryNeedBonus,
        completeMakeup,
        makeLegacySchedule,
        makeSchedule
    };
});


