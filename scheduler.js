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

        if (difference < 0) {
            throw new Error(`${examKey} 시험은 이미 지났습니다.`);
        }
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
        const priority = importance * currentNeed / Math.sqrt(daysUntilExam);

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
        if (totalSlots < subjects.length) {
            throw new Error('공부 시간이 과목 수에 비해 너무 적습니다.');
        }

        const scored = subjects.map((subject) =>
            calculatePriority(subject, today)
        );
        const extraSlots = totalSlots - scored.length;
        const priorityTotal = scored.reduce(
            (sum, subject) => sum + subject.priority,
            0
        );
        const weights = scored.map((subject) =>
            priorityTotal === 0 ? 1 : subject.priority
        );
        const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);

        const allocations = scored.map((subject, index) => {
            const exactExtra = extraSlots * weights[index] / weightTotal;
            const wholeExtra = Math.floor(exactExtra);

            return {
                ...subject,
                allocatedSlots: 1 + wholeExtra,
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
    function makeSchedule(subjects, availableSlots, today) {
        if (!Array.isArray(availableSlots)) {
            throw new Error('가능한 시간 칸 목록이 올바르지 않습니다.');
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

        const allocations = distributeSlots(subjects, slots.length, today);
        const assignedCount = new Map(
            allocations.map((subject) => [subject.id, 0])
        );
        const remainingCount = new Map(
            allocations.map((subject) => [subject.id, subject.allocatedSlots])
        );
        const schedule = [];

        for (const slot of slots) {
            const candidates = allocations
                .filter((subject) =>
                    remainingCount.get(subject.id) > 0 &&
                    subject.examDate >= slot.studyDate
                )
                .sort((a, b) => {
                    const aProgress = assignedCount.get(a.id) / a.allocatedSlots;
                    const bProgress = assignedCount.get(b.id) / b.allocatedSlots;

                    if (aProgress !== bProgress) {
                        return aProgress - bProgress;
                    }
                    return b.priority - a.priority;
                });

            const chosen = candidates[0];
            if (!chosen) {
                throw new Error('시험일까지 과목을 배치할 수 있는 시간이 부족합니다.');
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

        const unassignedSubjects = allocations.filter(
            (subject) => remainingCount.get(subject.id) > 0
        );
        if (unassignedSubjects.length > 0) {
            throw new Error('시험일까지 과목을 배치할 수 있는 시간이 부족합니다.');
        }

        return { allocations, schedule };
    }

    return {
        calculatePriority,
        distributeSlots,
        makeSchedule
    };
});


