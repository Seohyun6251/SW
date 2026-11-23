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

    function getWeekdayIndex(dateKey) {
        // JavaScript의 일요일 0 기준을 월요일 0 기준으로 바꿉니다.
        return (new Date(dateKeyToUtc(dateKey)).getUTCDay() + 6) % 7;
    }

    function countRecurringSlotsBeforeExam(recurringSlots, startSlot, examDate) {
        const startDate = toDateKey(startSlot.studyDate, '공부');
        const endDate = toDateKey(examDate, '시험');
        const startTime = dateKeyToUtc(startDate);
        const endTime = dateKeyToUtc(endDate);
        let count = 0;

        for (let time = startTime; time < endTime; time += DAY_MS) {
            const dateKey = new Date(time).toISOString().slice(0, 10);
            const weekdayIndex = getWeekdayIndex(dateKey);

            for (const recurringSlot of recurringSlots) {
                if (recurringSlot.dayIndex !== weekdayIndex) continue;
                if (dateKey === startDate && recurringSlot.startHour < startSlot.startHour) continue;
                count++;
            }
        }

        return count;
    }

    function getPreviousDateKey(dateKey) {
        return new Date(dateKeyToUtc(dateKey) - DAY_MS).toISOString().slice(0, 10);
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

    function makeSchedule(
        subjects,
        availableSlots,
        today,
        fixedSchedule = [],
        priorityDate = today,
        totalWeekSlotCount,
        recurringSlots = []
    ) {
        if (!Array.isArray(availableSlots)) {
            throw new Error('가능한 시간 칸 목록이 올바르지 않습니다.');
        }
        if (!Array.isArray(fixedSchedule)) {
            throw new Error('이미 지난 시간표가 올바르지 않습니다.');
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

        const recurringSlotTemplate = recurringSlots
            .map((slot) => ({
                dayIndex: Number(slot.dayIndex),
                startHour: Number(slot.startHour)
            }))
            .filter((slot) =>
                Number.isInteger(slot.dayIndex) && slot.dayIndex >= 0 && slot.dayIndex <= 6 &&
                Number.isInteger(slot.startHour) && slot.startHour >= 9 && slot.startHour <= 21
            );

        // 생성 대상 칸보다 시험이 먼저인 과목만 제외합니다.
        // 정규 주차의 누락된 지난 칸을 채울 때도 그 당시 시험 전 과목을 배정할 수 있습니다.
        const firstSlotDate = slots.length > 0
            ? slots[0].studyDate
            : toDateKey(today, '오늘');
        subjects = subjects.filter((subject) =>
            toDateKey(subject.examDate, '시험') > firstSlotDate
        );
        if (subjects.length === 0) {
            return { allocations: [], schedule: [] };
        }

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

        function getMondayExamReservation(slotIndex, candidates) {
            const slot = slots[slotIndex];
            const mondayExamCandidates = candidates.filter((subject) => {
                const examDate = toDateKey(subject.examDate, '시험');
                return getWeekdayIndex(examDate) === 0 &&
                    slots.slice(slotIndex).some((candidateSlot) =>
                        candidateSlot.studyDate === getPreviousDateKey(examDate)
                    );
            });
            if (mondayExamCandidates.length === 0) return null;

            const sundayDate = getPreviousDateKey(mondayExamCandidates[0].examDate);
            const remainingSundaySlots = slots.slice(slotIndex)
                .filter((candidateSlot) => candidateSlot.studyDate === sundayDate).length;
            const remainingMondayDemand = mondayExamCandidates.reduce(
                (sum, subject) => sum + remainingCount.get(subject.id),
                0
            );

            if (slot.studyDate === sundayDate) {
                return {
                    mondayExamCandidates,
                    candidates: mondayExamCandidates,
                    maxBlockLength: Infinity
                };
            }

            const hoursNeededBeforeSunday = remainingMondayDemand - remainingSundaySlots;
            if (slot.studyDate < sundayDate && hoursNeededBeforeSunday > 0) {
                return {
                    mondayExamCandidates,
                    candidates: mondayExamCandidates,
                    maxBlockLength: hoursNeededBeforeSunday
                };
            }

            return { mondayExamCandidates, candidates: [], maxBlockLength: 0 };
        }

        function getCandidates(slotIndex) {
            const slot = slots[slotIndex];
            const eligible = remainingAllocations
                .filter((subject) =>
                    remainingCount.get(subject.id) > 0 && subject.examDate > slot.studyDate
                )
                .map((subject) => {
                    const eligibleSlots = recurringSlotTemplate.length > 0
                        ? countRecurringSlotsBeforeExam(
                            recurringSlotTemplate,
                            slot,
                            subject.examDate
                        )
                        : slots.slice(slotIndex)
                            .filter((candidateSlot) => candidateSlot.studyDate < subject.examDate).length;
                    return {
                        ...subject,
                        urgency: eligibleSlots > 0 ? remainingCount.get(subject.id) / eligibleSlots : Infinity,
                        eligibleSlots
                    };
                })
                .sort((a, b) =>
                    b.urgency - a.urgency ||
                    a.examDate.localeCompare(b.examDate) ||
                    b.priority - a.priority
                );
            const mondayReservation = getMondayExamReservation(slotIndex, eligible);
            if (mondayReservation?.candidates.length > 0) {
                return mondayReservation.candidates.map((subject) => ({
                    ...subject,
                    maxBlockLength: mondayReservation.maxBlockLength
                }));
            }

            const nonReservedCandidates = mondayReservation
                ? eligible.filter((subject) => !mondayReservation.mondayExamCandidates.includes(subject))
                : eligible;
            if (nonReservedCandidates.length > 0) return nonReservedCandidates;
            if (eligible.length > 0) return eligible;

            // 시험이 지난 과목에 남은 목표 칸은 더 배정할 수 없으므로,
            // 현재 칸이 시험 전인 과목 중 우선순위가 높은 과목으로 넘깁니다.
            return remainingAllocations
                .filter((subject) => subject.examDate > slot.studyDate)
                .sort((a, b) =>
                    a.examDate.localeCompare(b.examDate) || b.priority - a.priority
                )
                .slice(0, 1)
                .map((subject) => ({ ...subject, urgency: Infinity, overflow: true }));
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

                if (chosen.overflow) remainingCount.set(chosen.id, 1);
                const blockLength = Math.min(
                    remainingCount.get(chosen.id),
                    runEnd - slotIndex,
                    chosen.maxBlockLength ?? Infinity
                );
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
                                eligibleSlots: subject.eligibleSlots,
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
                    const eligibleSlots = recurringSlotTemplate.length > 0
                        ? countRecurringSlotsBeforeExam(
                            recurringSlotTemplate,
                            item,
                            subject.examDate
                        )
                        : slots.slice(index)
                            .filter((slot) => slot.studyDate < subject.examDate).length;
                    const remaining = Math.max(0, subject.allocatedSlots - assignedBefore);
                    return {
                        subjectId: subject.id,
                        subjectName: subject.name,
                        assignedBefore,
                        allocatedSlots: subject.allocatedSlots,
                        progress: subject.allocatedSlots > 0 ? assignedBefore / subject.allocatedSlots : 1,
                        urgency: eligibleSlots > 0 ? remaining / eligibleSlots : Infinity,
                        eligibleSlots,
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
        makeSchedule
    };
});


