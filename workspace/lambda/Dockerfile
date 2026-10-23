FROM public.ecr.aws/lambda/python:3.12

COPY lambda/requirements.txt ${LAMBDA_TASK_ROOT}/requirements.txt
COPY backend/requirements.txt ${LAMBDA_TASK_ROOT}/backend/requirements.txt
COPY api/requirements.txt ${LAMBDA_TASK_ROOT}/api/requirements.txt
RUN pip install --no-cache-dir -r ${LAMBDA_TASK_ROOT}/requirements.txt

COPY lambda/handler.py ${LAMBDA_TASK_ROOT}/handler.py
COPY api ${LAMBDA_TASK_ROOT}/api
COPY backend/app ${LAMBDA_TASK_ROOT}/backend/app
COPY database ${LAMBDA_TASK_ROOT}/backend/database

ENV PYTHONPATH=${LAMBDA_TASK_ROOT}/backend:${LAMBDA_TASK_ROOT}/api
CMD ["handler.handler"]